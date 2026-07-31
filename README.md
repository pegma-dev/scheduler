# Scheduler

Durable coordination for host-triggered recurring work in the Pegma stack.

Scheduler sits between a host runtime's timer and bounded domain work. The
runtime decides when to wake up. Scheduler will own static registration,
durable checkpoints, overlap leases, stale-run fencing, and safe run state.
The domain package continues to own idempotency, retries, and business-safe
writes.

## Status

Phase 3 is implemented in source. The repository contains
`@pegma/scheduler` (contracts, durable runner), `@pegma/scheduler-cloudflare`
(explicit Cron Trigger dispatch), Memory Store / Azurite / local D1 tests, and
design documentation. No package has been published.

The first consumers are:

- Support Desk mail, queue-repair, and retention loops on Azure and Cloudflare;
- Ops Hub health probes and GitHub organization synchronization in a local
  Docker-only Cloudflare Worker host.

## Packages

| Package                       | Status         | Responsibility                              |
| ----------------------------- | -------------- | ------------------------------------------- |
| `@pegma/scheduler`            | Phase 3 source | Contracts, durable task state, and runner   |
| `@pegma/scheduler-cloudflare` | Phase 3 source | Thin explicit Cron Trigger dispatch adapter |

## Development

```sh
npm ci
npm run format:check
npm run check
npm test
# or separately:
npm run test:node
npm run test:d1
```

See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the delivery sequence.
