import type { PaymentProvider } from '../provider.interface.js';
import { PaystackProvider } from './paystack.provider.js';
import { BadRequestError } from '@common/errors.js';

const providers = new Map<string, PaymentProvider>();

const paystack = new PaystackProvider();
providers.set('paystack', paystack);

export function getPaymentProvider(name: string): PaymentProvider {
  const provider = providers.get(name.toLowerCase());
  if (!provider) {
    throw new BadRequestError(`Unsupported payment provider: ${name}`);
  }
  return provider;
}

export function registerPaymentProvider(provider: PaymentProvider): void {
  providers.set(provider.name.toLowerCase(), provider);
}
