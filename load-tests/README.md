# Load Testing Guide (Phase 12: Scaling to Millions of Users)

This directory contains production load testing scripts built with **Grafana k6** to prove scalability, low latency, and transactional correctness under heavy concurrency.

---

## 1. Prerequisites

Install k6:

- **macOS**: `brew install k6`
- **Windows**: `winget install k6` or `choco install k6`
- **Linux**: `sudo apt install k6`

---

## 2. Test Scenarios & SLO Targets

| Scenario             | File                 | Description                                                        | Target SLO                                   |
| -------------------- | -------------------- | ------------------------------------------------------------------ | -------------------------------------------- |
| **Catalog Browsing** | `browse-catalog.js`  | 90% read load: keyset pagination, ETag conditional caching, search | p95 < 200ms, error rate < 0.1%               |
| **Flash Sale Race**  | `flash-sale-race.js` | High-contention atomic checkout on limited-stock SKU               | p95 < 800ms, zero overselling, 0% 500 errors |

---

## 3. Running the Tests

### Scenario 1: Catalog Read Throughput

```bash
k6 run load-tests/browse-catalog.js
```

### Scenario 2: Flash Sale Contention

```bash
k6 run -e BASE_URL=http://localhost:3000 \
       -e PRODUCT_ID=<PRODUCT_ID> \
       -e AUTH_TOKEN=<JWT_ACCESS_TOKEN> \
       load-tests/flash-sale-race.js
```

---

## 4. Invariant Verification Post-Test

After running high-concurrency checkout tests, run the invariant checker to confirm zero oversold stock:

```bash
npm run seed:admin # or trigger invariant-checker
```

Invariant: For all products, `0 <= reserved <= onHand`.
