# High-Scale E-Commerce Backend

A production-grade, horizontally scalable e-commerce backend built with **Node.js 22 LTS**, **Fastify**, **TypeScript**, **MongoDB (replica sets with transactions)**, **Redis**, and **BullMQ**. Engineered from first principles to handle millions of concurrent users with provable consistency and zero overselling.

---

## Key Features & Architecture Highlights

- **Atomic Inventory Guarantees (Zero Oversell Invariant):**
  Uses atomic conditional MongoDB updates (`$expr: { $gte: [{ $subtract: ['$onHand', '$reserved'] }, qty] }`) inside snapshot transactions. Document-level write serialization completely eliminates race conditions without distributed application locks.
- **Reservation Lifecycle (Scenario F):**
  Temporary inventory reservation during checkout window (15-minute TTL) with BullMQ delayed release and periodic reconciliation sweepers. Auto-commits on verified payment; auto-releases on abandonment.
- **Idempotency Everywhere:**
  IETF-compliant `Idempotency-Key` middleware with SHA-256 request payload validation, preventing duplicate checkouts, double billing, or duplicate admin mutations.
- **Transactional Outbox Pattern:**
  Guarantees reliable post-commit side-effects (payment dispatch, cart clearing) without dual-write race conditions.
- **Security & RBAC Matrix:**
  Argon2id password hashing, rotating refresh tokens with token family reuse breach detection, strict owner-scoped data isolation (anti-IDOR), timing-safe HMAC SHA-512 webhook validation, and role-based access control.
- **Real-Time Observability & Invariant Checker:**
  Structured JSON logging with Pino and tracing `x-request-id`, Prometheus-ready metrics, circuit breakers on external gateways, and continuous database invariant assertions.

---

## Tech Stack

| Component            | Technology                     | Rationale                                                           |
| -------------------- | ------------------------------ | ------------------------------------------------------------------- |
| **Runtime**          | Node.js 22 LTS                 | High-throughput asynchronous event loop                             |
| **Framework**        | Fastify 5                      | 2× faster than Express, native schema compilation                   |
| **Language**         | TypeScript 5.8 (Strict)        | End-to-end type safety                                              |
| **Primary Database** | MongoDB 8 (Replica Set)        | ACID multi-document transactions, WiredTiger engine                 |
| **Cache & Queues**   | Redis 7 + BullMQ               | Ephemeral session tokens, distributed caching, delayed jobs         |
| **Testing**          | Vitest + mongodb-memory-server | 119+ integration and concurrency tests running against replica sets |
| **Load Testing**     | Grafana k6                     | Real-time performance and race condition benchmarks                 |

---

## Quick Start

### 1. Prerequisites

- [Node.js](https://nodejs.org/) v22+
- [Docker & Docker Compose](https://www.docker.com/)

### 2. Environment Setup

```bash
# Clone the repository
git clone https://github.com/olumideakinloye/E-commerce_Backend.git
cd E-commerce_Backend

# Copy sample environment
cp .env.example .env
```

### 3. Start Infrastructure (MongoDB Replica Set & Redis)

```bash
docker compose up -d
```

_Note: The Docker Compose configuration automatically provisions a 3-node MongoDB replica set and Redis instance._

### 4. Install Dependencies & Build

```bash
npm install
npm run build
```

### 5. Seed Admin User & Sample Catalog

```bash
npm run seed:admin
```

_Default admin credentials will be displayed in console output._

### 6. Start Server

```bash
# Development (with hot-reload)
npm run dev

# Production
npm start
```

The server will start on `http://localhost:3000`.

---

## API Documentation & Exploration

- **Interactive Swagger UI:** Visit `http://localhost:3000/docs` in your browser.
- **OpenAPI 3.1 Spec:** Committed at [`docs/openapi.yaml`](./docs/openapi.yaml).
- **Postman Collection & Environment:** Ready to import from [`docs/postman_collection.json`](./docs/postman_collection.json) and [`docs/postman_environment.json`](./docs/postman_environment.json).

---

## Running Automated Tests

All tests execute against an **in-memory replica set** with full MongoDB multi-document transactions enabled. No local MongoDB installation or manual configuration is required.

```bash
# Run complete test suite (119+ tests across 16 suites)
npm test

# Run tests in watch mode
npm run test:watch

# Run linter and typechecker
npm run typecheck
npm run lint
```

### Test Suite Overview

- **Unit Tests:** Pricing math, JWT token families, state machines, HMAC signatures.
- **Integration Tests:** Auth, Catalog, Cart, Orders, Payments, Outbox processor, Reliability.
- **E2E Happy Path:** Complete customer journey: Register → Browse → Cart → Idempotent Checkout → Paystack Webhook → Order PAID → Stock committed.
- **Concurrency & Race Tests:** Concurrent duplicate checkouts, race for the last unit of stock, isolation under load.
- **Security RBAC Matrix:** 401 unauthenticated, 403 forbidden, anti-IDOR checks, and JWT tampering verification.
- **Invariant Checker Tests:** Asserts stock bounds (`0 <= reserved <= onHand`) and order-reservation commitment.

---

## Project Structure

```
├── docs/                     # OpenAPI 3.1 YAML, Postman collections & environments
├── load-tests/               # Grafana k6 performance and concurrency scripts
├── src/
│   ├── app.ts                # Fastify application factory, plugins, hooks
│   ├── server.ts             # Server entrypoint, database bootstraps, graceful shutdown
│   ├── config/               # Zod-validated environment configuration
│   ├── common/               # Cross-cutting utilities, errors, middleware, models
│   │   ├── middleware/       # Auth, RBAC, Idempotency, Ownership guards
│   │   ├── models/           # IdempotencyKey, AuditLog schemas
│   │   └── utils/            # CircuitBreaker, Transactions, Audit logger, Tokens
│   ├── infra/                # Mongo & Redis connection pools & health checks
│   └── modules/              # Domain-Driven Modules
│       ├── auth/             # Registration, Argon2id, JWT token rotation
│       ├── cart/             # Atomic cart updates, live re-pricing
│       ├── inventory/        # Conditional stock reservation, BullMQ queues
│       ├── jobs/             # Outbox dispatcher, Invariant checker
│       ├── orders/           # Order state machine, checkout, repositories
│       ├── payments/         # Payment provider interface, Paystack adapter, Webhooks
│       └── products/         # Keyset-paginated catalog, text search, Redis caching
└── tests/
    ├── helpers/              # In-memory MongoDB replica set setup & teardown
    ├── integration/          # 14 integration test suites
    └── unit/                 # 2 unit test suites
```

---

## Scaling to Millions of Users

For the complete architectural breakdown covering horizontal scaling, MongoDB sharding keys, stock bucketing for flash sales, Redis cache stampede protection, and disaster recovery strategies, see [**DESIGN.md**](./DESIGN.md).
