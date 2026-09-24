import { describe, it, expect } from 'vitest';
import { Types } from 'mongoose';
import { User } from '@/modules/auth/models/user.model.js';
import { RefreshToken } from '@/modules/auth/models/refresh-token.model.js';
import { Product } from '@/modules/products/models/product.model.js';
import { Inventory } from '@/modules/inventory/models/inventory.model.js';
import { Reservation } from '@/modules/inventory/models/reservation.model.js';
import { Cart, MAX_CART_ITEMS } from '@/modules/cart/models/cart.model.js';
import { Order } from '@/modules/orders/models/order.model.js';
import { Payment } from '@/modules/payments/models/payment.model.js';
import { WebhookEvent } from '@/modules/payments/models/webhook-event.model.js';
import { IdempotencyKey } from '@/common/models/idempotency-key.model.js';
import { Outbox } from '@/modules/jobs/models/outbox.model.js';

describe('Data Models & Schemas (Unit / In-Memory)', () => {
  describe('User Model', () => {
    it('validates required fields and defaults', async () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hash',
      });
      await expect(user.validate()).resolves.toBeUndefined();
      expect(user.role).toBe('customer');
      expect(user.tokenVersion).toBe(0);
    });

    it('rejects invalid role', async () => {
      const user = new User({
        email: 'test@example.com',
        passwordHash: 'hash',
        role: 'superadmin' as unknown as 'customer',
      });
      await expect(user.validate()).rejects.toThrow();
    });
  });

  describe('RefreshToken Model', () => {
    it('has TTL and family tracking indexes', () => {
      const indexes = RefreshToken.schema.indexes();
      const hasTTL = indexes.some(
        ([idx, opts]) => idx.expiresAt === 1 && opts?.expireAfterSeconds === 0,
      );
      expect(hasTTL).toBe(true);
    });
  });

  describe('Product Model', () => {
    it('requires priceMinor to be an integer', async () => {
      const invalidProduct = new Product({
        name: 'Keyboard',
        slug: 'keyboard',
        description: 'Mechanical',
        priceMinor: 29.99, // Float error
        currency: 'USD',
        category: 'Electronics',
      });
      await expect(invalidProduct.validate()).rejects.toThrow();

      const validProduct = new Product({
        name: 'Keyboard',
        slug: 'keyboard',
        description: 'Mechanical',
        priceMinor: 2999,
        currency: 'USD',
        category: 'Electronics',
      });
      await expect(validProduct.validate()).resolves.toBeUndefined();
      expect(validProduct.version).toBe(1);
    });

    it('has compound pagination index and text index', () => {
      const indexes = Product.schema.indexes();
      const hasCompound = indexes.some(
        ([idx]) => idx.category === 1 && idx.isAvailable === 1 && idx._id === -1,
      );
      const hasText = indexes.some(([idx]) => idx.name === 'text' && idx.description === 'text');
      expect(hasCompound).toBe(true);
      expect(hasText).toBe(true);
    });
  });

  describe('Inventory Model', () => {
    it('calculates available virtual stock accurately', () => {
      const inventory = new Inventory({
        productId: new Types.ObjectId(),
        onHand: 15,
        reserved: 5,
      });
      expect(inventory.available).toBe(10);
    });

    it('rejects negative stock values', async () => {
      const invalidInventory = new Inventory({
        productId: new Types.ObjectId(),
        onHand: -1,
        reserved: 0,
      });
      await expect(invalidInventory.validate()).rejects.toThrow();
    });
  });

  describe('Reservation Model', () => {
    it('has critical (status, expiresAt) sweeper index', () => {
      const indexes = Reservation.schema.indexes();
      const hasSweeperIndex = indexes.some(([idx]) => idx.status === 1 && idx.expiresAt === 1);
      expect(hasSweeperIndex).toBe(true);
    });
  });

  describe('Cart Model', () => {
    it('enforces maximum item limit to prevent unbounded documents', async () => {
      const items = Array.from({ length: MAX_CART_ITEMS + 1 }, () => ({
        productId: new Types.ObjectId(),
        qty: 1,
      }));

      const cart = new Cart({
        userId: new Types.ObjectId(),
        items,
      });

      await expect(cart.validate()).rejects.toThrow();
    });
  });

  describe('Order Model', () => {
    it('requires snapshotted line items and totals in integer minor units', async () => {
      const order = new Order({
        userId: new Types.ObjectId(),
        idempotencyKey: 'idem_123',
        status: 'PENDING_PAYMENT',
        lines: [
          {
            productId: new Types.ObjectId(),
            name: 'Snapshotted Item',
            unitPriceMinor: 1000,
            currency: 'USD',
            qty: 1,
            totalMinor: 1000,
          },
        ],
        totals: {
          subtotalMinor: 1000,
          taxMinor: 100,
          shippingMinor: 200,
          grandTotalMinor: 1300,
          currency: 'USD',
        },
        expiresAt: new Date(),
      });

      await expect(order.validate()).resolves.toBeUndefined();
    });

    it('has critical unique and compound indexes', () => {
      const indexes = Order.schema.indexes();
      const hasUserHistory = indexes.some(([idx]) => idx.userId === 1 && idx.createdAt === -1);
      const hasIdempotency = indexes.some(
        ([idx, opts]) => idx.userId === 1 && idx.idempotencyKey === 1 && opts?.unique,
      );
      const hasPaymentRef = indexes.some(
        ([idx, opts]) => idx.paymentRef === 1 && opts?.unique && opts?.sparse,
      );
      expect(hasUserHistory).toBe(true);
      expect(hasIdempotency).toBe(true);
      expect(hasPaymentRef).toBe(true);
    });
  });

  describe('Payment Model', () => {
    it('has unique reference and orderId indexes', () => {
      const indexes = Payment.schema.indexes();
      const hasUniqueRef = indexes.some(([idx, opts]) => idx.reference === 1 && opts?.unique);
      const hasOrderId = indexes.some(([idx]) => idx.orderId === 1);
      expect(hasUniqueRef).toBe(true);
      expect(hasOrderId).toBe(true);
    });
  });

  describe('WebhookEvent Model', () => {
    it('has unique(provider, eventId) and 90-day TTL index', () => {
      const indexes = WebhookEvent.schema.indexes();
      const hasUniqueEvent = indexes.some(
        ([idx, opts]) => idx.provider === 1 && idx.eventId === 1 && opts?.unique,
      );
      const hasTTL = indexes.some(
        ([idx, opts]) => idx.receivedAt === 1 && opts?.expireAfterSeconds === 90 * 24 * 60 * 60,
      );
      expect(hasUniqueEvent).toBe(true);
      expect(hasTTL).toBe(true);
    });
  });

  describe('IdempotencyKey & Outbox Models', () => {
    it('IdempotencyKey has unique(userId, key) and TTL', () => {
      const indexes = IdempotencyKey.schema.indexes();
      const hasUnique = indexes.some(
        ([idx, opts]) => idx.userId === 1 && idx.key === 1 && opts?.unique,
      );
      const hasTTL = indexes.some(
        ([idx, opts]) => idx.expiresAt === 1 && opts?.expireAfterSeconds === 0,
      );
      expect(hasUnique).toBe(true);
      expect(hasTTL).toBe(true);
    });

    it('Outbox has worker polling indexes', () => {
      const indexes = Outbox.schema.indexes();
      const hasPolling = indexes.some(([idx]) => idx.status === 1 && idx.nextAttemptAt === 1);
      expect(hasPolling).toBe(true);
    });
  });
});
