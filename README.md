# Core Ledger

## Overview

This repository contains a Node.js + TypeScript ledger service built on MongoDB with Mongoose.
It implements the actual codebase in this project, including event sourcing, snapshot replay, idempotency, and a live verification endpoint.

## What this code implements

- Account creation
- Transfers between accounts
- Holds lifecycle: place, capture, void
- Snapshot-based state recovery
- Event sourcing and deterministic replay
- Idempotent command handling via `Idempotency-Key`
- Invariant verification via `/api/verification/invariants`

## Storage and persistence

This implementation uses MongoDB as its storage primitive.
The project stores:

- `Event` documents for append-only ledger events
- `Snapshot` documents for account checkpoints
- `Idempotency` documents for command deduplication

## Key implementation details

### Ledger engine

The main ledger logic is in `src/ledger/engine.ts`.
It provides:

- `LedgerEngine.apply_event()` — deterministic reducer for account state
- `LedgerEngine.get_account_state()` — latest snapshot plus replay of newer events
- `LedgerEngine.process_command()` — validates commands, builds events, persists them, updates snapshots, and stores idempotency responses

### Command and event model

Commands are defined as discriminated union types in `src/ledger/engine.ts`.
Supported commands:

- `open_account`
- `transfer`
- `place_hold`
- `capture_hold`
- `void_hold`

Events are also discriminated unions and include:

- `account_opened`
- `money_transferred`
- `hold_placed`
- `hold_captured`
- `hold_voided`

### Transaction handling

The HTTP controller in `src/controllers/ledger.controller.ts` attempts to use MongoDB sessions and transactions.
If transactions are unavailable, it falls back to a session-aware path while still preserving idempotency and snapshot updates as much as possible.

### Idempotency

Every write command is deduplicated using `IdempotencyModel` in MongoDB.
If the same `Idempotency-Key` is received again, the stored response is returned without reapplying effects.

### Snapshot and replay

Account state is reconstructed from the latest `Snapshot` plus any events with a higher version number.
Snapshots are updated after event persistence.
The verification endpoint replays events for each account and compares the replayed state against the stored snapshot state.

## API endpoints

All API routes are mounted under `/api`.

### Write endpoints

- `POST /api/accounts`
  - Body: `{ account_id, account_type }`
- `POST /api/transfers`
  - Body: `{ from_account_id, to_account_id, amount }`
- `POST /api/holds`
  - Body: `{ account_id, hold_id, amount }`
- `POST /api/holds/:id/capture`
  - Body: `{ account_id }`
- `POST /api/holds/:id/void`
  - Body: `{ account_id }`

### Read endpoints

- `GET /api/accounts/:id/balance`
- `GET /api/verification/invariants`

### Headers

Write requests should include:

- `Idempotency-Key`

## Run instructions

1. Install dependencies:

```bash
npm install
```

2. Create a `.env` file with:

```env
PORT=3000
MONGODB_URI=mongodb://localhost:27017/core-ledger
```

3. Build the project:

```bash
npm run build
```

4. Start the service:

```bash
npm start
```

5. Run the verification harness:

```bash
npm run verify
```

The `verify` script calls the live API on `http://localhost:<PORT>/api` and runs a chaos test that ends with `/api/verification/invariants`.

## Notes from the current codebase

- The project uses MongoDB via `mongoose`.
- The verification harness is a script-based chaos test, not a dedicated property-based test suite.
- There is no `statement` endpoint implemented in the current code.
- The audit endpoint checks snapshot replay correctness and the closed-system balance.

## Actual constraints reflected in code

- Strict TypeScript typing
- Discriminated union commands/events
- Integer money amounts only
- Snapshot + event replay recovery
- Idempotency via a dedicated collection

## Important caveat

This README is written to reflect the current project code exactly.
If you want additional endpoints or real property-based tests, those would need to be added separately.
