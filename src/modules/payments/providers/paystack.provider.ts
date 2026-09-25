import crypto from 'node:crypto';
import type {
  PaymentProvider,
  InitializePaymentParams,
  InitializePaymentResult,
  VerifyPaymentResult,
  NormalizedWebhookEvent,
} from '../provider.interface.js';
import { env } from '@config/env.js';
import { logger } from '@common/logger.js';

export class PaystackProvider implements PaymentProvider {
  public readonly name = 'paystack' as const;

  private getSecretKey(): string {
    return env.PAYSTACK_SECRET_KEY || env.PAYMENT_WEBHOOK_SECRET;
  }

  async initialize(params: InitializePaymentParams): Promise<InitializePaymentResult> {
    const authUrl = `https://checkout.paystack.com/${params.reference}`;
    return {
      reference: params.reference,
      authorizationUrl: authUrl,
    };
  }

  async verify(reference: string): Promise<VerifyPaymentResult> {
    // If running in live mode with valid secret key, could make HTTP call
    // Default fallback / simulation for test and offline sandbox
    return {
      status: 'PENDING',
      amountMinor: 0,
      currency: 'USD',
      reference,
    };
  }

  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader?: string | string[]): boolean {
    if (!signatureHeader || typeof signatureHeader !== 'string') {
      return false;
    }

    const secret = this.getSecretKey();
    if (!secret) return false;

    try {
      const computedHash = crypto.createHmac('sha512', secret).update(rawBody).digest('hex');

      const expectedBuf = Buffer.from(computedHash, 'utf-8');
      const actualBuf = Buffer.from(signatureHeader, 'utf-8');

      if (expectedBuf.length !== actualBuf.length) {
        return false;
      }

      return crypto.timingSafeEqual(expectedBuf, actualBuf);
    } catch (err) {
      logger.error({ err }, 'Error verifying Paystack webhook signature');
      return false;
    }
  }

  parseWebhookEvent(rawBody: Buffer | string): NormalizedWebhookEvent {
    const bodyStr = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf-8');
    const parsed = JSON.parse(bodyStr) as Record<string, unknown>;

    const eventName = String(parsed.event || '');
    const data = (parsed.data || {}) as Record<string, unknown>;

    let eventType: NormalizedWebhookEvent['eventType'] = 'other';
    if (eventName === 'charge.success') {
      eventType = 'charge.success';
    } else if (eventName === 'charge.failed') {
      eventType = 'charge.failed';
    }

    const eventId = String(data.id ?? parsed.id ?? `event_${Date.now()}`);
    const reference = String(data.reference ?? '');
    const amountMinor = typeof data.amount === 'number' ? data.amount : 0;
    const currency = String(data.currency || 'USD').toUpperCase();

    return {
      eventId,
      eventType,
      reference,
      amountMinor,
      currency,
      rawPayload: parsed,
    };
  }
}
