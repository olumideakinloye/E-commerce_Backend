export interface InitializePaymentParams {
  orderId: string;
  reference: string;
  amountMinor: number;
  currency: string;
  customerEmail?: string;
}

export interface InitializePaymentResult {
  reference: string;
  authorizationUrl: string;
}

export interface VerifyPaymentResult {
  status: 'SUCCESS' | 'FAILED' | 'PENDING';
  amountMinor: number;
  currency: string;
  paidAt?: Date;
  reference: string;
  rawResponse?: unknown;
}

export interface NormalizedWebhookEvent {
  eventId: string;
  eventType: 'charge.success' | 'charge.failed' | 'other';
  reference: string;
  amountMinor: number;
  currency: string;
  rawPayload: Record<string, unknown>;
}

export interface PaymentProvider {
  name: 'paystack' | 'stripe';
  initialize(params: InitializePaymentParams): Promise<InitializePaymentResult>;
  verify(reference: string): Promise<VerifyPaymentResult>;
  verifyWebhookSignature(rawBody: Buffer | string, signatureHeader?: string | string[]): boolean;
  parseWebhookEvent(rawBody: Buffer | string): NormalizedWebhookEvent;
}
