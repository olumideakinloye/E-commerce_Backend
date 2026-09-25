import http from 'k6/http';
import { check, sleep } from 'k6';

export const options = {
  stages: [
    { duration: '30s', target: 50 },  // Ramp-up to 50 virtual users
    { duration: '1m', target: 100 },  // Sustain 100 virtual users
    { duration: '30s', target: 200 },  // Peak burst of 200 virtual users
    { duration: '30s', target: 0 },    // Ramp-down
  ],
  thresholds: {
    http_req_duration: ['p(95)<200'], // 95% of requests must complete below 200ms
    http_req_failed: ['rate<0.01'],    // Less than 1% failure rate
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:3000';

export default function () {
  // 1. Browse catalog with keyset pagination
  const catalogRes = http.get(`${BASE_URL}/api/v1/products?limit=20`);
  check(catalogRes, {
    'catalog status is 200': (r) => r.status === 200,
    'has ETag': (r) => r.headers['Etag'] !== undefined || r.headers['ETag'] !== undefined,
  });

  // 2. Fetch specific product with conditional caching (ETag)
  const etag = catalogRes.headers['Etag'] || catalogRes.headers['ETag'];
  if (etag) {
    const conditionalRes = http.get(`${BASE_URL}/api/v1/products`, {
      headers: { 'If-None-Match': etag },
    });
    check(conditionalRes, {
      'conditional read is 200 or 304': (r) => r.status === 200 || r.status === 304,
    });
  }

  // 3. Search catalog
  const searchRes = http.get(`${BASE_URL}/api/v1/products?q=wireless`);
  check(searchRes, {
    'search status is 200': (r) => r.status === 200,
  });

  sleep(1);
}
