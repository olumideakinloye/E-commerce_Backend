import crypto from 'node:crypto';
import { Types } from 'mongoose';
import { Order, type OrderDoc } from './models/order.model.js';
import { Payment } from '@modules/payments/models/payment.model.js';
import { Outbox } from '@modules/jobs/models/outbox.model.js';
import { IdempotencyKey } from '@common/models/idempotency-key.model.js';
import { withRetryableTransaction } from '@common/utils/transaction.js';
import { getLiveCart } from '@modules/cart/cart.service.js';
import {
  reserveStockInSession,
  releaseReservation,
  commitReservation,
  RESERVATION_TTL_MS,
} from '@modules/inventory/reservation.service.js';
import { scheduleReservationExpiry } from '@modules/inventory/reservation.queue.js';
import {
  findOrderByIdForUser,
  listOrdersForUser,
  transitionOrderStatus,
} from './orders.repository.js';
import { AppError, UnprocessableEntityError } from '@common/errors.js';
import type { CheckoutInput, OrderListQuery } from './orders.schemas.js';

export async function getOrderById(orderId: string, userId: string): Promise<OrderDoc> {
  return findOrderByIdForUser(orderId, userId);
}

export async function listOrders(
  userId: string,
  query: OrderListQuery,
): Promise<{ orders: OrderDoc[]; nextCursor: string | null; hasMore: boolean }> {
  return listOrdersForUser(userId, query);
}

export async function cancelOrder(orderId: string, userId: string): Promise<OrderDoc> {
  // First ensure order exists and belongs to user (anti-IDOR)
  await findOrderByIdForUser(orderId, userId);

  const updated = await transitionOrderStatus(orderId, 'PENDING_PAYMENT', 'CANCELLED');
  if (!updated) {
    throw new UnprocessableEntityError('Only pending payment orders can be cancelled');
  }

  // Release reserved stock back to inventory
  await releaseReservation(orderId);

  return updated;
}

export interface CheckoutResult {
  statusCode: number;
  body: {
    order: {
      id: string;
      status: string;
      totals: {
        grandTotalMinor: number;
        currency: string;
      };
      expiresAt: string;
    };
    payment: {
      provider: string;
      reference: string;
      authorizationUrl: string;
    };
  };
}

/**
 * Execute checkout flow with:
 * 1. Idempotency validation (Scenario C)
 * 2. Live cart re-pricing and stock validation
 * 3. Scenario B: strict expectedTotalMinor check (409 PRICE_CHANGED if different)
 * 4. Scenario A & C: Atomic multi-collection transaction:
 *    - Reserve inventory
 *    - Snapshot order lines
 *    - Create PENDING_PAYMENT order
 *    - Create INITIATED payment
 *    - Write INITIATE_PAYMENT and CLEAR_CART outbox events
 * 5. Out-of-transaction payment gateway URL generation + BullMQ expiry scheduling
 */
export async function checkout(
  userId: string,
  input: CheckoutInput,
  idempotencyKey: string,
): Promise<CheckoutResult> {
  const userObjectId = new Types.ObjectId(userId);

  // 1. Idempotency store check
  const requestHash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');

  const existingKey = await IdempotencyKey.findOne({
    userId: userObjectId,
    key: idempotencyKey,
  });

  if (existingKey) {
    if (existingKey.requestHash === requestHash && existingKey.response) {
      return {
        statusCode: existingKey.response.statusCode,
        body: existingKey.response.body as CheckoutResult['body'],
      };
    } else {
      throw new UnprocessableEntityError(
        'Idempotency key has already been used with a different request payload',
      );
    }
  }

  // 2. Load live cart
  const liveCart = await getLiveCart(userId);
  if (liveCart.items.length === 0) {
    throw new UnprocessableEntityError('Cannot checkout with an empty cart');
  }

  const hasUnavailable = liveCart.items.some(
    (item) => item.warnings.includes('OUT_OF_STOCK') || item.warnings.includes('UNAVAILABLE'),
  );
  if (hasUnavailable) {
    throw new UnprocessableEntityError(
      'One or more items in your cart are currently out of stock or unavailable',
      liveCart.warnings,
    );
  }

  // 3. Scenario B: Verify expectedTotalMinor matches current server-computed grand total
  const calculatedGrandTotalMinor = liveCart.subtotalMinor; // taxMinor = 0, shippingMinor = 0 for now
  if (input.expectedTotalMinor !== calculatedGrandTotalMinor) {
    throw new AppError(
      'Cart prices or items have changed since they were last displayed. Please review the updated total and confirm.',
      409,
      'PRICE_CHANGED',
      {
        expectedTotalMinor: input.expectedTotalMinor,
        currentTotalMinor: calculatedGrandTotalMinor,
        items: liveCart.items,
      },
    );
  }

  // 4. Atomic transaction across Inventory, Order, Payment, and Outbox (Scenario C)
  const orderId = new Types.ObjectId();
  const paymentRef = `pay_${crypto.randomBytes(16).toString('hex')}`;
  const expiresAt = new Date(Date.now() + RESERVATION_TTL_MS);

  const reservationItems = liveCart.items.map((item) => ({
    productId: item.productId,
    qty: item.qty,
  }));

  const orderLines = liveCart.items.map((item) => ({
    productId: new Types.ObjectId(item.productId),
    name: item.name,
    unitPriceMinor: item.priceMinor,
    currency: item.currency,
    qty: item.qty,
    totalMinor: item.subtotalMinor,
  }));

  let createdOrderId = orderId;
  let createdPaymentRef = paymentRef;
  let createdExpiresAt = expiresAt;

  try {
    await withRetryableTransaction(async (session) => {
      // Check if order was already created concurrently with this idempotency key
      const existing = await Order.findOne({ userId: userObjectId, idempotencyKey }).session(
        session,
      );
      if (existing) {
        createdOrderId = existing._id as Types.ObjectId;
        createdPaymentRef = existing.paymentRef || paymentRef;
        if (existing.expiresAt) {
          createdExpiresAt = existing.expiresAt;
        }
        return;
      }

      // 4a. Conditionally reserve stock (rolls back whole transaction if insufficient stock)
      await reserveStockInSession(orderId, reservationItems, session);

      // 4b. Create Order with snapshotted lines
      await Order.create(
        [
          {
            _id: orderId,
            userId: userObjectId,
            status: 'PENDING_PAYMENT',
            lines: orderLines,
            totals: {
              subtotalMinor: calculatedGrandTotalMinor,
              taxMinor: 0,
              shippingMinor: 0,
              grandTotalMinor: calculatedGrandTotalMinor,
              currency: input.currency,
            },
            paymentRef,
            idempotencyKey,
            expiresAt,
          },
        ],
        { session },
      );

      // 4c. Create Payment record in INITIATED state
      await Payment.create(
        [
          {
            orderId,
            provider: input.paymentProvider,
            reference: paymentRef,
            status: 'INITIATED',
            amountMinor: calculatedGrandTotalMinor,
            currency: input.currency,
          },
        ],
        { session },
      );

      // 4d. Write Outbox events committed atomically with the order
      await Outbox.create(
        [
          {
            type: 'INITIATE_PAYMENT',
            payload: {
              orderId: orderId.toString(),
              paymentRef,
              amountMinor: calculatedGrandTotalMinor,
              currency: input.currency,
              provider: input.paymentProvider,
            },
            status: 'PENDING',
          },
          {
            type: 'CLEAR_CART',
            payload: {
              userId,
            },
            status: 'PENDING',
          },
        ],
        { session, ordered: true },
      );
    });
  } catch (err: unknown) {
    if (
      err &&
      typeof err === 'object' &&
      'code' in err &&
      (err as { code: number }).code === 11000
    ) {
      // Concurrent duplicate idempotency key caught by unique index
      const existingOrder = await Order.findOne({ userId: userObjectId, idempotencyKey });
      if (existingOrder) {
        createdOrderId = existingOrder._id as Types.ObjectId;
        createdPaymentRef = existingOrder.paymentRef || paymentRef;
        if (existingOrder.expiresAt) {
          createdExpiresAt = existingOrder.expiresAt;
        }
      } else {
        throw err;
      }
    } else {
      throw err;
    }
  }

  // 5. Post-commit operations (outside the DB transaction)
  // Schedule delayed expiry job only if this request actually created the order
  if (createdOrderId === orderId) {
    await scheduleReservationExpiry(orderId.toString(), RESERVATION_TTL_MS);
  }

  const responseBody = {
    order: {
      id: createdOrderId.toString(),
      status: 'PENDING_PAYMENT',
      totals: {
        grandTotalMinor: calculatedGrandTotalMinor,
        currency: input.currency,
      },
      expiresAt: createdExpiresAt.toISOString(),
    },
    payment: {
      provider: input.paymentProvider,
      reference: createdPaymentRef,
      authorizationUrl: `https://checkout.${input.paymentProvider}.com/pay/${createdPaymentRef}`,
    },
  };

  // 6. Record idempotency response (24h TTL)
  try {
    await IdempotencyKey.create({
      key: idempotencyKey,
      userId: userObjectId,
      requestHash,
      response: {
        statusCode: 201,
        headers: {},
        body: responseBody,
      },
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
  } catch {
    // If another concurrent request wrote the key, that's fine
  }

  return {
    statusCode: 201,
    body: responseBody,
  };
}

/**
 * Transition order to PAID status upon verified payment.
 * Guarded by atomic CAS.
 * Idempotent: safe against duplicate webhooks / callbacks.
 */
export async function markOrderPaid(orderId: string, paymentRef: string): Promise<OrderDoc | null> {
  const updatedOrder = await transitionOrderStatus(orderId, 'PENDING_PAYMENT', 'PAID', {
    paymentRef,
  });

  if (updatedOrder) {
    // Commit the reserved inventory
    await commitReservation(orderId);
  }

  return updatedOrder;
}

/**
 * Transition order to PAYMENT_FAILED status.
 * Releases reserved inventory.
 */
export async function markOrderPaymentFailed(orderId: string): Promise<OrderDoc | null> {
  const updatedOrder = await transitionOrderStatus(orderId, 'PENDING_PAYMENT', 'PAYMENT_FAILED');

  if (updatedOrder) {
    await releaseReservation(orderId);
  }

  return updatedOrder;
}

/**
 * Expire order past payment TTL.
 * Releases reserved inventory.
 */
export async function expireOrder(orderId: string): Promise<OrderDoc | null> {
  const updatedOrder = await transitionOrderStatus(orderId, 'PENDING_PAYMENT', 'EXPIRED');

  if (updatedOrder) {
    await releaseReservation(orderId);
  }

  return updatedOrder;
}
