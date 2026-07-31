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

The current tests prove:

- static task registration preserves literal names;
- invalid or accessor-backed registrations fail without invoking getters;
- task state round-trips through a flat Storage Core codec;
- running state requires a complete lease;
- completed state cannot retain stale lease fields;
- checkpoints and failure categories reject unsafe values;
- instance and task IDs form the expected physical key.

## Runner adversarial matrix

Phase 2 is incomplete until tests cover:

- two workers racing for an unseen task;
- two workers racing for an existing task;
- live-lease skip;
- expired-lease recovery;
- stale completion after recovery;
- crash before task call;
- crash after side effect but before completion;
- failure without checkpoint advancement;
- string checkpoint advancement;
- null checkpoint cycle completion;
- omitted checkpoint retention;
- old scheduled occurrence after a newer success;
- conflict retries with a freshly evaluated decider;
- handler timeout shorter than the lease;
- malformed persisted rows and prototype/accessor inputs;
- bounded safe summaries and failure categories.

## Adapter and consumer matrix

Before publication, run the core against:

- Memory Store for fast deterministic tests;
- real local Cloudflare D1 through Wrangler;
- real Azurite through `@pegma/storage-azure-tables`;
- an Ops Hub health and GitHub-sync fixture;
- Support Desk mail-send, reconciliation, terminal sweep, queue repair, and
  inactive-sweep fixtures.

Memory tests are never a production durability claim.
