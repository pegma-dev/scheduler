# Scheduler

Durable coordination for host-triggered recurring work in the Pegma stack.

Scheduler sits between a host runtime's timer and bounded domain work. The
runtime decides when to wake up. Scheduler will own static registration,
durable checkpoints, overlap leases, stale-run fencing, and safe run state.
The domain package continues to own idempotency, retries, and business-safe
writes.

## Status

Phase 2 is implemented in source. The repository contains the
`@pegma/scheduler` contracts, validated task registry, durable runner
(`createScheduler`), Memory Store and Azurite adversarial tests, and design
documentation. No package has been published.

The first consumers are:

- Support Desk mail, queue-repair, and retention loops on Azure and Cloudflare;
- Ops Hub health probes and GitHub organization synchronization in a local
  Docker-only Cloudflare Worker host.

## Packages

| Package                       | Status          | Responsibility                              |
| ----------------------------- | --------------- | ------------------------------------------- |
| `@pegma/scheduler`            | Phase 2 source  | Contracts, durable task state, and runner   |
| `@pegma/scheduler-cloudflare` | Planned Phase 3 | Thin explicit Cron Trigger dispatch adapter |

Do not create the Cloudflare package directory until its implementation starts.

## Development

```sh
npm ci
npm run format:check
npm run check
npm test
```

See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the delivery sequence.
