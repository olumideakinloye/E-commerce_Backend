import { Schema, model, type Document, type InferSchemaType } from 'mongoose';

export type UserRole = 'customer' | 'admin';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
    },
    role: {
      type: String,
      enum: ['customer', 'admin'] as const,
      default: 'customer' as const,
      required: true,
      index: true,
    },
    tokenVersion: {
      type: Number,
      default: 0,
      required: true,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
);

export type UserDoc = InferSchemaType<typeof userSchema> & Document;
export const User = model<UserDoc>('User', userSchema);
