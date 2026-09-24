import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

const productSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    description: {
      type: String,
      required: true,
    },
    priceMinor: {
      type: Number,
      required: true,
      min: 0,
      validate: {
        validator: Number.isInteger,
        message: '{VALUE} must be an integer minor currency unit',
      },
    },
    currency: {
      type: String,
      required: true,
      uppercase: true,
      trim: true,
      minlength: 3,
      maxlength: 3,
      default: 'USD',
    },
    category: {
      type: String,
      required: true,
      trim: true,
      index: true,
    },
    tags: {
      type: [String],
      default: [],
    },
    isAvailable: {
      type: Boolean,
      default: true,
      index: true,
    },
    archivedAt: {
      type: Date,
      default: null,
    },
    version: {
      type: Number,
      default: 1,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

// Compound index for catalog browsing and keyset/cursor pagination
productSchema.index({ category: 1, isAvailable: 1, _id: -1 });

// Text index on name and description for catalog search
productSchema.index({ name: 'text', description: 'text' });

export type ProductDoc = InferSchemaType<typeof productSchema> & Document;
export const Product = model<ProductDoc>('Product', productSchema);
