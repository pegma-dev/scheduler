# Scheduler

Durable coordination for host-triggered recurring work in the Pegma stack.

Scheduler sits between a host runtime's timer and bounded domain work. The
runtime decides when to wake up. Scheduler will own static registration,
durable checkpoints, overlap leases, stale-run fencing, and safe run state.
The domain package continues to own idempotency, retries, and business-safe
writes.

## Status

**Published:** `@pegma/scheduler@0.1.0` and `@pegma/scheduler-cloudflare@0.1.0`
(`latest` on npm). The repository contains contracts, the durable runner,
Cloudflare Cron Trigger dispatch, independent consumer fixtures under
`fixtures/`, Memory Store / Azurite / local D1 tests, and OIDC release
automation. Bootstrap `0.0.0` remains under the `bootstrap` dist-tag only.

The first consumers are:

- Support Desk mail, queue-repair, and retention loops on Azure and Cloudflare;
- Ops Hub health probes and GitHub organization synchronization in a local
  Docker-only Cloudflare Worker host.

## Packages

| Package                       | Status           | Responsibility                              |
| ----------------------------- | ---------------- | ------------------------------------------- |
| `@pegma/scheduler`            | **0.1.0** on npm | Contracts, durable task state, and runner   |
| `@pegma/scheduler-cloudflare` | **0.1.0** on npm | Thin explicit Cron Trigger dispatch adapter |

## Development

```sh
pnpm install --frozen-lockfile
pnpm run format:check
pnpm run check
pnpm test
# or separately:
pnpm run test:node
pnpm run test:d1
```

Consumer fixtures (Ops Hub, Support Desk, Azure Functions shapes) live under
[fixtures/](fixtures/) and run as part of `pnpm test`.

See [docs/PROJECT_PLAN.md](docs/PROJECT_PLAN.md) for the delivery sequence.
