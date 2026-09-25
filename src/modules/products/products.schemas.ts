import { z } from 'zod';

export const ListProductsQuerySchema = z.object({
  category: z.string().trim().optional(),
  search: z.string().trim().optional(),
  sort: z.enum(['newest', 'price_asc', 'price_desc']).default('newest'),
  cursor: z.string().trim().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const CreateProductBodySchema = z.object({
  name: z.string().trim().min(1, 'Name is required').max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(
      /^[a-z0-9]+(?:-[a-z0-9]+)*$/,
      'Slug must be URL-safe (lowercase letters, numbers, hyphens)',
    )
    .optional(),
  description: z.string().trim().min(1, 'Description is required'),
  priceMinor: z
    .number()
    .int('Price must be an integer in minor units')
    .nonnegative('Price cannot be negative'),
  currency: z.string().trim().length(3).toUpperCase().default('USD'),
  category: z.string().trim().min(1, 'Category is required'),
  tags: z.array(z.string().trim()).default([]),
  initialStock: z.number().int().nonnegative().default(0),
});

export const UpdateProductBodySchema = z.object({
  name: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().min(1).optional(),
  priceMinor: z.number().int().nonnegative().optional(),
  currency: z.string().trim().length(3).toUpperCase().optional(),
  category: z.string().trim().min(1).optional(),
  tags: z.array(z.string().trim()).optional(),
});

export const UpdateAvailabilityBodySchema = z.object({
  isAvailable: z.boolean(),
});

export const UpdateInventoryBodySchema = z.object({
  onHand: z.number().int('onHand must be an integer').nonnegative('onHand cannot be negative'),
});

export type ListProductsQuery = z.infer<typeof ListProductsQuerySchema>;
export type CreateProductBody = z.infer<typeof CreateProductBodySchema>;
export type UpdateProductBody = z.infer<typeof UpdateProductBodySchema>;
export type UpdateAvailabilityBody = z.infer<typeof UpdateAvailabilityBodySchema>;
export type UpdateInventoryBody = z.infer<typeof UpdateInventoryBodySchema>;
