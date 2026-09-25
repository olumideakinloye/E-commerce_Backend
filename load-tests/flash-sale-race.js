import http from 'k6/http';
import { check } from 'k6';

export const options = {
  scenarios: {
    flash_sale_burst: {
      executor: 'shared-iterations',
      vus: 50,
      iterations: 200,
      maxDuration: '1m',
    },
  },
  thresholds: {
    // Under extreme contention on the same row, p95 should remain under 800ms
    http_req_duration: ['p(95)<800'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';
const PRODUCT_ID = __ENV.PRODUCT_ID || 'mock_product_id';
const TOKEN = __ENV.AUTH_TOKEN || 'mock_jwt_token';

export default function () {
  const idempotencyKey = `k6-sale-${__VU}-${__ITER}-${Date.now()}`;

  const payload = JSON.stringify({
    expectedTotalMinor: 10000,
    currency: 'NGN',
    paymentProvider: 'paystack',
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${TOKEN}`,
      'idempotency-key': idempotencyKey,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/orders/checkout`, payload, params);

  // In a flash sale, successful purchases get 201, while sold-out users get 409 (insufficient stock)
  // Both are expected and valid business outcomes. 500 errors violate correctness.
  check(res, {
    'status is 201 (success) or 409 (out of stock)': (r) => r.status === 201 || r.status === 409,
    'no 500 errors': (r) => r.status !== 500,
  });
}
