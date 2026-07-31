# Verification strategy

## Gate

Every change must pass:

```sh
npm run format:check
npm run check
npm test
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

## Adapter and consumer matrix

Before publication, also run:

- real local Cloudflare D1 through Wrangler (Phase 3);
- an Ops Hub health and GitHub-sync fixture (Phase 4);
- Support Desk mail-send, reconciliation, terminal sweep, queue repair, and
  inactive-sweep fixtures (Phase 4).

Memory tests are never a production durability claim.
