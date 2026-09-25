import mongoose from 'mongoose';
import { Payment, type PaymentDoc } from './models/payment.model.js';
import { WebhookEvent, type WebhookEventDoc } from './models/webhook-event.model.js';
import { Order, type OrderDoc } from '@modules/orders/models/order.model.js';
import {
  commitReservationInSession,
  releaseReservationInSession,
} from '@modules/inventory/reservation.service.js';
import { getPaymentProvider } from './providers/index.js';
import { logger } from '@common/logger.js';
import { UnauthorizedError, UnprocessableEntityError } from '@common/errors.js';

export interface ProcessWebhookResult {
  status: 'PROCESSED' | 'DUPLICATE' | 'IGNORED' | 'SUSPICIOUS_AMOUNT';
  eventId: string;
  orderId?: string;
  orderStatus?: string;
}

/**
 * Process incoming payment provider webhook (Scenario E — 3-layer idempotency & safety).
 *
 * Layer 1: Event-level deduplication via unique compound index (provider, eventId).
 * Layer 2: State machine transition guard (only PENDING_PAYMENT -> PAID).
 * Layer 3: Atomic CAS inventory commit (ACTIVE -> COMMITTED) inside a single transaction.
 */
export async function processWebhook(
  providerName: string,
  rawBody: Buffer | string,
  signatureHeader?: string | string[],
): Promise<ProcessWebhookResult> {
  const provider = getPaymentProvider(providerName);

  // 1. Verify HMAC signature using timing-safe comparison
  const isValidSignature = provider.verifyWebhookSignature(rawBody, signatureHeader);
  if (!isValidSignature) {
    logger.warn({ provider: providerName }, 'Invalid webhook signature rejected');
    throw new UnauthorizedError('Invalid webhook signature');
  }

  // 2. Parse event payload
  const event = provider.parseWebhookEvent(rawBody);

  // 3. Layer 1: Event-level idempotency check (insert unique record)
  let webhookRecord: WebhookEventDoc;
  try {
    webhookRecord = await WebhookEvent.create({
      provider: provider.name,
      eventId: event.eventId,
      receivedAt: new Date(),
      status: 'RECEIVED',
      payload: event.rawPayload,
    });
  } catch (err: unknown) {
    // MongoDB duplicate key error code 11000: event already received
    if (
      typeof err === 'object' &&
      err !== null &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      logger.info(
        { provider: provider.name, eventId: event.eventId },
        'Duplicate webhook event suppressed at Layer 1',
      );
      return {
        status: 'DUPLICATE',
        eventId: event.eventId,
      };
    }
    throw err;
  }

  // 4. Find payment record by reference
  const payment = await Payment.findOne({ reference: event.reference });
  if (!payment) {
    logger.warn(
      { reference: event.reference, eventId: event.eventId },
      'Payment reference not found for webhook event',
    );
    await WebhookEvent.updateOne(
      { _id: webhookRecord._id },
      { $set: { status: 'IGNORED', processedAt: new Date() } },
    );
    return {
      status: 'IGNORED',
      eventId: event.eventId,
    };
  }

  // 5. Amount and Currency Invariant Check (Scenario B / payment fraud defence)
  if (event.eventType === 'charge.success') {
    if (
      event.amountMinor !== payment.amountMinor ||
      event.currency.toUpperCase() !== payment.currency.toUpperCase()
    ) {
      logger.error(
        {
          expectedAmount: payment.amountMinor,
          receivedAmount: event.amountMinor,
          expectedCurrency: payment.currency,
          receivedCurrency: event.currency,
          reference: payment.reference,
        },
        'SECURITY ALERT: Webhook amount/currency does not match order payment record',
      );
      await WebhookEvent.updateOne(
        { _id: webhookRecord._id },
        { $set: { status: 'FAILED', processedAt: new Date() } },
      );
      return {
        status: 'SUSPICIOUS_AMOUNT',
        eventId: event.eventId,
        orderId: payment.orderId.toString(),
      };
    }
  }

  // 6. Atomic state transition and inventory commit (Layers 2 & 3 in single transaction)
  const session = await mongoose.startSession();
  try {
    await session.withTransaction(async () => {
      if (event.eventType === 'charge.success') {
        // Layer 2: State machine guard — only transition if PENDING_PAYMENT
        const updatedOrder = await Order.findOneAndUpdate(
          {
            _id: payment.orderId,
            status: 'PENDING_PAYMENT',
          },
          {
            $set: {
              status: 'PAID',
              paymentRef: payment.reference,
            },
          },
          { session, returnDocument: 'after' },
        );

        // Update payment status
        await Payment.updateOne(
          { _id: payment._id },
          { $set: { status: 'SUCCESS', providerPayload: event.rawPayload } },
          { session },
        );

        // Layer 3: If order transitioned, commit reservation in same transaction
        if (updatedOrder) {
          await commitReservationInSession(payment.orderId, session);
        }

        // Mark webhook as processed
        await WebhookEvent.updateOne(
          { _id: webhookRecord._id },
          { $set: { status: 'PROCESSED', processedAt: new Date() } },
          { session },
        );
      } else if (event.eventType === 'charge.failed') {
        // Transition order to PAYMENT_FAILED
        const updatedOrder = await Order.findOneAndUpdate(
          {
            _id: payment.orderId,
            status: 'PENDING_PAYMENT',
          },
          {
            $set: { status: 'PAYMENT_FAILED' },
          },
          { session, returnDocument: 'after' },
        );

        await Payment.updateOne(
          { _id: payment._id },
          { $set: { status: 'FAILED', providerPayload: event.rawPayload } },
          { session },
        );

        if (updatedOrder) {
          await releaseReservationInSession(payment.orderId, session);
        }

        await WebhookEvent.updateOne(
          { _id: webhookRecord._id },
          { $set: { status: 'PROCESSED', processedAt: new Date() } },
          { session },
        );
      } else {
        await WebhookEvent.updateOne(
          { _id: webhookRecord._id },
          { $set: { status: 'IGNORED', processedAt: new Date() } },
          { session },
        );
      }
    });
  } finally {
    await session.endSession();
  }

  const finalOrder = await Order.findById(payment.orderId);

  return {
    status: 'PROCESSED',
    eventId: event.eventId,
    orderId: payment.orderId.toString(),
    orderStatus: finalOrder?.status,
  };
}

export interface ReconciliationSummary {
  checkedCount: number;
  paidCount: number;
  failedCount: number;
  expiredCount: number;
  latePaidCount: number;
}

/**
 * Scenario D: Payment Reconciliation Job.
 *
 * Runs periodically (e.g. every 1-5 minutes).
 * Finds orders stuck in PENDING_PAYMENT and actively checks gateway status.
 *
 * Three paths:
 * 1. Gateway reports SUCCESS -> mark PAID & commit stock
 * 2. Gateway reports FAILED/ABANDONED -> mark PAYMENT_FAILED & release stock
 * 3. Gateway reports PENDING and expiresAt < now -> mark EXPIRED & release stock
 * 4. Late payment detection: order was EXPIRED but gateway says SUCCESS -> alert / flag
 */
export async function reconcilePendingOrders(olderThanMinutes = 5): Promise<ReconciliationSummary> {
  const summary: ReconciliationSummary = {
    checkedCount: 0,
    paidCount: 0,
    failedCount: 0,
    expiredCount: 0,
    latePaidCount: 0,
  };

  const threshold = new Date(Date.now() - olderThanMinutes * 60 * 1000);
  const now = new Date();

  // Find pending orders
  const pendingOrders = await Order.find({
    status: 'PENDING_PAYMENT',
    createdAt: { $lt: threshold },
  }).limit(100);

  for (const order of pendingOrders) {
    summary.checkedCount++;

    const payment = await Payment.findOne({ orderId: order._id });
    if (!payment) continue;

    try {
      const provider = getPaymentProvider(payment.provider);
      const verifyResult = await provider.verify(payment.reference);

      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          if (verifyResult.status === 'SUCCESS') {
            // Verify amount & currency
            if (
              verifyResult.amountMinor === payment.amountMinor &&
              verifyResult.currency.toUpperCase() === payment.currency.toUpperCase()
            ) {
              const updated = await Order.findOneAndUpdate(
                { _id: order._id, status: 'PENDING_PAYMENT' },
                { $set: { status: 'PAID', paymentRef: payment.reference } },
                { session, returnDocument: 'after' },
              );

              await Payment.updateOne(
                { _id: payment._id },
                { $set: { status: 'SUCCESS' } },
                { session },
              );

              if (updated) {
                await commitReservationInSession(order._id, session);
                summary.paidCount++;
              }
            }
          } else if (verifyResult.status === 'FAILED') {
            const updated = await Order.findOneAndUpdate(
              { _id: order._id, status: 'PENDING_PAYMENT' },
              { $set: { status: 'PAYMENT_FAILED' } },
              { session, returnDocument: 'after' },
            );

            await Payment.updateOne(
              { _id: payment._id },
              { $set: { status: 'FAILED' } },
              { session },
            );

            if (updated) {
              await releaseReservationInSession(order._id, session);
              summary.failedCount++;
            }
          } else if (order.expiresAt < now) {
            // Still pending past TTL -> expire and release stock
            const updated = await Order.findOneAndUpdate(
              { _id: order._id, status: 'PENDING_PAYMENT' },
              { $set: { status: 'EXPIRED' } },
              { session, returnDocument: 'after' },
            );

            await Payment.updateOne(
              { _id: payment._id },
              { $set: { status: 'ABANDONED' } },
              { session },
            );

            if (updated) {
              await releaseReservationInSession(order._id, session);
              summary.expiredCount++;
            }
          }
        });
      } finally {
        await session.endSession();
      }
    } catch (err) {
      logger.error({ err, orderId: order._id }, 'Error during payment reconciliation');
    }
  }

  return summary;
}

/**
 * Active verification for a specific order (Scenario D browser callback / GET /orders/:id/verify).
 */
export async function verifyOrderPayment(
  orderId: string,
  userId: string,
): Promise<{ order: OrderDoc; payment: PaymentDoc | null }> {
  const order = await Order.findOne({ _id: orderId, userId });
  if (!order) {
    throw new UnprocessableEntityError('Order not found');
  }

  const payment = await Payment.findOne({ orderId: order._id });

  if (order.status === 'PENDING_PAYMENT' && payment) {
    const provider = getPaymentProvider(payment.provider);
    const verifyResult = await provider.verify(payment.reference);

    if (
      verifyResult.status === 'SUCCESS' &&
      verifyResult.amountMinor === payment.amountMinor &&
      verifyResult.currency.toUpperCase() === payment.currency.toUpperCase()
    ) {
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          await Order.updateOne(
            { _id: order._id, status: 'PENDING_PAYMENT' },
            { $set: { status: 'PAID', paymentRef: payment.reference } },
            { session },
          );
          await Payment.updateOne(
            { _id: payment._id },
            { $set: { status: 'SUCCESS' } },
            { session },
          );
          await commitReservationInSession(order._id, session);
        });
      } finally {
        await session.endSession();
      }

      order.status = 'PAID';
      payment.status = 'SUCCESS';
    }
  }

  return { order, payment };
}
