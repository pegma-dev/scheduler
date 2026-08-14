# Verification strategy

## Gate

Every change must pass:

```sh
pnpm run format:check
pnpm run check
pnpm test
```

CI runs the gate on Node 22 and 24.

## Phase 1 coverage

Contract tests prove:

- static task registration preserves literal names;
- invalid or accessor-backed registrations fail without invoking getters;
- task state round-trips through a flat Storage Core codec;
- running state requires a complete lease;
- completed state cannot retain stale lease fields;
- checkpoints and failure categories reject unsafe values;
- instance and task IDs form the expected physical key.

## Phase 2 runner coverage

Adversarial Memory Store tests cover:

- two workers racing for an unseen task;
- two workers racing for an existing task;
- live-lease skip;
- expired-lease recovery;
- stale completion after recovery;
- crash before task call (no durable row without a claim);
- crash after side effect but before completion (at-least-once re-run);
- failure without checkpoint advancement;
- string checkpoint advancement;
- null checkpoint cycle completion;
- omitted checkpoint retention;
- old scheduled occurrence after a newer success;
- conflict-safe claims via Storage Core `update` deciders;
- handler timeout shorter than the lease;
- prototype/accessor-safe registration and bounded safe summaries;
- failure categories that refuse raw secret-bearing classifier output.

Azurite tests through `@pegma/storage-azure-tables` cover a complete
checkpoint cycle, occurrence suppression, and concurrent claim fencing on a
real Table Storage protocol endpoint. Vitest starts Azurite via
`test/azurite.ts` for the full suite.

## Phase 3 Cloudflare adapter coverage

Adapter unit tests cover:

- cron route dispatch and multi-task routes;
- `scheduledTime` → `scheduledFor` conversion;
- `waitUntil` registration;
- unmapped cron fail-closed behavior;
- overlap suppression and checkpoint cycles through the adapter.

Real local D1 tests (`pnpm run test:d1`) through
`@pegma/storage-cloudflare-d1` and the Cloudflare Workers Vitest pool cover:

- a complete checkpoint cycle with occurrence suppression;
- durable state surviving a re-composed “restart”;
- concurrent claim fencing on the same task;
- `waitUntil` wiring on the execution context.

## Phase 4 consumer fixture coverage

Independent fixtures under `fixtures/` pin workspace package versions and prove:

- Ops Hub: health + GitHub routes, independent checkpoints, live-lease overlap;
- Support Desk: five direct loops, independent checkpoints, no dynamic
  receipt-bucket tasks, failure retains checkpoints without secrets;
- Azure Functions: timer entry point, checkpoint cycle, stale redelivery.

## Adapter and consumer matrix

Before publication, also run full host applications when they exist:

- Ops Hub Worker + Docker volume story (host still bootstrap-only);
- Support Desk production host wiring after `@pegma/scheduler@0.1.0` publishes.

Memory tests are never a production durability claim.
