import { z } from 'zod';

export const checkoutSchema = z.object({
  expectedTotalMinor: z
    .number()
    .int('expectedTotalMinor must be an integer')
    .min(0, 'expectedTotalMinor cannot be negative'),
  currency: z
    .string()
    .length(3, 'currency must be a 3-letter ISO code')
    .toUpperCase()
    .default('USD'),
  paymentProvider: z.enum(['paystack', 'stripe']).default('paystack'),
  shippingAddress: z
    .object({
      line1: z.string().min(1, 'line1 is required'),
      line2: z.string().optional(),
      city: z.string().min(1, 'city is required'),
      state: z.string().optional(),
      postalCode: z.string().min(1, 'postalCode is required'),
      country: z.string().min(2, 'country is required'),
    })
    .optional(),
});

export type CheckoutInput = z.infer<typeof checkoutSchema>;

export const orderListQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  status: z
    .enum([
      'PENDING_PAYMENT',
      'PAID',
      'PAYMENT_FAILED',
      'EXPIRED',
      'CANCELLED',
      'FULFILLED',
      'REFUNDED',
    ])
    .optional(),
});

export type OrderListQuery = z.infer<typeof orderListQuerySchema>;

export const orderIdParamSchema = z.object({
  id: z.string().regex(/^[0-9a-fA-F]{24}$/, 'Invalid order ID format'),
});

export type OrderIdParam = z.infer<typeof orderIdParamSchema>;
