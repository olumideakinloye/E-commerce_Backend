import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '@/app.js';
import { User } from '@modules/auth/models/user.model.js';
import { Product } from '@modules/products/models/product.model.js';
import { Inventory } from '@modules/inventory/models/inventory.model.js';
import { Cart } from '@modules/cart/models/cart.model.js';
import { signAccessToken } from '@common/utils/tokens.js';
import { setupTestReplSet, teardownTestReplSet, clearTestDatabase } from '../helpers/db.js';

describe('Cart (integration)', () => {
  let app: FastifyInstance;
  let userAToken: string;
  let userBToken: string;

  beforeAll(async () => {
    await setupTestReplSet();
    await User.init();
    await Product.init();
    await Inventory.init();
    await Cart.init();

    app = buildApp() as unknown as FastifyInstance;
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
    await teardownTestReplSet();
  });

  beforeEach(async () => {
    await clearTestDatabase();

    const userA = await User.create({
      email: 'usera@example.com',
      passwordHash: 'dummy',
      role: 'customer',
      tokenVersion: 0,
    });
    userAToken = signAccessToken({ sub: userA._id.toString(), role: 'customer', tokenVersion: 0 });

    const userB = await User.create({
      email: 'userb@example.com',
      passwordHash: 'dummy',
      role: 'customer',
      tokenVersion: 0,
    });
    userBToken = signAccessToken({ sub: userB._id.toString(), role: 'customer', tokenVersion: 0 });
  });

  const authHeader = (token: string) => ({ authorization: `Bearer ${token}` });

  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
    });
    expect(res.statusCode).toBe(401);
  });

  it('isolates carts between different users (Anti-IDOR)', async () => {
    const prod = await Product.create({
      name: 'Item 1',
      slug: 'item-1',
      description: 'Desc',
      priceMinor: 1000,
      currency: 'USD',
      category: 'general',
      isAvailable: true,
      version: 1,
    });
    await Inventory.create({ productId: prod._id, onHand: 10, reserved: 0 });

    // User A adds item
    const addRes = await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      payload: { productId: prod._id.toString(), qty: 2 },
      headers: authHeader(userAToken),
    });
    expect(addRes.statusCode).toBe(200);
    expect(addRes.json().itemCount).toBe(2);

    // User B checks cart -> empty!
    const userBCart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userBToken),
    });
    expect(userBCart.statusCode).toBe(200);
    expect(userBCart.json().items).toHaveLength(0);
    expect(userBCart.json().subtotalMinor).toBe(0);
  });

  it('re-prices cart items live from catalog when catalog price changes', async () => {
    const prod = await Product.create({
      name: 'Dynamic Price Item',
      slug: 'dynamic-item',
      description: 'Desc',
      priceMinor: 2000,
      currency: 'USD',
      category: 'general',
      isAvailable: true,
      version: 1,
    });
    await Inventory.create({ productId: prod._id, onHand: 10, reserved: 0 });

    // Add 2 items @ 2000 = 4000
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      payload: { productId: prod._id.toString(), qty: 2 },
      headers: authHeader(userAToken),
    });

    const cart1 = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(cart1.json().subtotalMinor).toBe(4000);

    // Admin / system updates product price to 3500
    await Product.findByIdAndUpdate(prod._id, { priceMinor: 3500, version: 2 });

    // Fetch cart again -> immediately reflects 3500 * 2 = 7000!
    const cart2 = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(cart2.json().subtotalMinor).toBe(7000);
    expect(cart2.json().items[0].priceMinor).toBe(3500);
  });

  it('handles stock changes with live warnings (OUT_OF_STOCK and QUANTITY_REDUCED)', async () => {
    const prod = await Product.create({
      name: 'Limited Stock Item',
      slug: 'limited-stock-item',
      description: 'Desc',
      priceMinor: 1000,
      currency: 'USD',
      category: 'general',
      isAvailable: true,
      version: 1,
    });
    const inv = await Inventory.create({ productId: prod._id, onHand: 5, reserved: 0 });

    // User adds 5 to cart
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      payload: { productId: prod._id.toString(), qty: 5 },
      headers: authHeader(userAToken),
    });

    // 1. Stock drops to 3 -> QUANTITY_REDUCED warning
    inv.onHand = 3;
    await inv.save();

    const reducedRes = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(reducedRes.statusCode).toBe(200);
    const reducedCart = reducedRes.json();
    expect(reducedCart.items[0].effectiveQty).toBe(3);
    expect(reducedCart.items[0].warnings).toContain('QUANTITY_REDUCED');
    expect(reducedCart.subtotalMinor).toBe(3000); // 3 * 1000

    // 2. Stock drops to 0 -> OUT_OF_STOCK warning
    inv.onHand = 0;
    await inv.save();

    const oosRes = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(oosRes.statusCode).toBe(200);
    const oosCart = oosRes.json();
    expect(oosCart.items[0].effectiveQty).toBe(0);
    expect(oosCart.items[0].warnings).toContain('OUT_OF_STOCK');
    expect(oosCart.subtotalMinor).toBe(0);

    // 3. Product archived/unavailable -> UNAVAILABLE warning
    await Product.findByIdAndUpdate(prod._id, { isAvailable: false, archivedAt: new Date() });

    const unavailRes = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(unavailRes.statusCode).toBe(200);
    const unavailCart = unavailRes.json();
    expect(unavailCart.items[0].warnings).toContain('UNAVAILABLE');
    expect(unavailCart.subtotalMinor).toBe(0);
  });

  it('updates quantity, removes items, and clears the cart', async () => {
    const prod1 = await Product.create({
      name: 'Item A',
      slug: 'item-a',
      description: 'Desc A',
      priceMinor: 1000,
      currency: 'USD',
      category: 'general',
      isAvailable: true,
      version: 1,
    });
    await Inventory.create({ productId: prod1._id, onHand: 50, reserved: 0 });

    const prod2 = await Product.create({
      name: 'Item B',
      slug: 'item-b',
      description: 'Desc B',
      priceMinor: 2000,
      currency: 'USD',
      category: 'general',
      isAvailable: true,
      version: 1,
    });
    await Inventory.create({ productId: prod2._id, onHand: 50, reserved: 0 });

    // Add items
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      payload: { productId: prod1._id.toString(), qty: 2 },
      headers: authHeader(userAToken),
    });
    await app.inject({
      method: 'POST',
      url: '/api/v1/cart/items',
      payload: { productId: prod2._id.toString(), qty: 1 },
      headers: authHeader(userAToken),
    });

    // Update item 1 quantity to 4
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/api/v1/cart/items/${prod1._id.toString()}`,
      payload: { qty: 4 },
      headers: authHeader(userAToken),
    });
    expect(patchRes.statusCode).toBe(200);
    expect(
      patchRes.json().items.find((i: { productId: string }) => i.productId === prod1._id.toString())
        .qty,
    ).toBe(4);
    expect(patchRes.json().subtotalMinor).toBe(4 * 1000 + 1 * 2000); // 6000

    // Remove item 2
    const delItemRes = await app.inject({
      method: 'DELETE',
      url: `/api/v1/cart/items/${prod2._id.toString()}`,
      headers: authHeader(userAToken),
    });
    expect(delItemRes.statusCode).toBe(200);
    expect(delItemRes.json().items).toHaveLength(1);
    expect(delItemRes.json().subtotalMinor).toBe(4000);

    // Clear whole cart
    const clearRes = await app.inject({
      method: 'DELETE',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(clearRes.statusCode).toBe(204);

    // Verify empty
    const finalCart = await app.inject({
      method: 'GET',
      url: '/api/v1/cart',
      headers: authHeader(userAToken),
    });
    expect(finalCart.json().items).toHaveLength(0);
    expect(finalCart.json().subtotalMinor).toBe(0);
  });
});
