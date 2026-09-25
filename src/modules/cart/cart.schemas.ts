import { z } from 'zod';

export const AddCartItemBodySchema = z.object({
  productId: z
    .string()
    .trim()
    .regex(/^[0-9a-fA-F]{24}$/, 'Invalid product ID format'),
  qty: z
    .number()
    .int('Quantity must be an integer')
    .min(1, 'Quantity must be at least 1')
    .max(99, 'Quantity cannot exceed 99')
    .default(1),
});

export const UpdateCartItemBodySchema = z.object({
  qty: z
    .number()
    .int('Quantity must be an integer')
    .min(1, 'Quantity must be at least 1')
    .max(99, 'Quantity cannot exceed 99'),
});

export type AddCartItemBody = z.infer<typeof AddCartItemBodySchema>;
export type UpdateCartItemBody = z.infer<typeof UpdateCartItemBodySchema>;
