# Working in this repository

Read this before changing anything. It is short on purpose.

## What this is part of

Scheduler is a Pegma component: a host-composed library for durable
coordination of recurring work. Shared time and logging contracts come from
`@pegma/spine`; persistence comes from `@pegma/storage-core`.

> **Optimize for a fresh agent context window.** Minimize what must be read to
> make a correct change, and mechanize how the change proves itself correct.

## Hard rules

**The host owns wakeups.** Cloudflare, Azure, Kubernetes, or a local driver
decides when execution begins. Never add an always-on process or claim that a
library can guarantee timer delivery.

**The domain owns durable work safety.** Scheduler leases protect a task run
and its checkpoint. They do not replace Mail claims, provider idempotency,
receipt deduplication, conditional sweeps, or a durable outbox.

**Tasks are explicit and static.** Register them once at the composition root.
No filesystem scanning, decorators, wildcard names, or arbitrary serialized
functions.

**Every invocation is bounded.** A handler performs one bounded unit or a
host-selected bounded batch. The scheduler never follows `more` into an
unbounded loop.

**A checkpoint belongs to exactly one task and instance.** Pass it through
unchanged. Persist it only after the handler succeeds. `null` closes a cycle;
the next occurrence begins without a checkpoint.

**At-least-once is honest.** A crash after an external side effect but before
completion can repeat work. Domain operations and provider calls must be
idempotent. Never document exactly-once execution.

**Take an injected Store.** The core package owns its collection definition
but never creates a Store or imports a storage adapter.

**Keep stored and logged failures coarse.** Never persist raw errors, stack
traces, provider bodies, secrets, email addresses, or customer content.

**No runtime dependencies beyond Pegma contracts.** Core uses web-standard
APIs and must run on Node, Workers, Deno, and Bun.

**Never write literal control characters into source.** Use escape sequences
such as backslash-u-0000 through backslash-u-001F and verify edited bytes.

## Packaging

Each published package needs its own README and LICENSE, a `prepack` build,
and a `tsconfig.json` that excludes `src/**/*.test.ts`.

## Workflow

Work on a `claude/*` branch and open a pull request. The gate is
`npm run format:check`, `npm run check`, and `npm test` on Node 22 and 24.

Publishing remains disabled until the runner, real D1/Azure verification, and
both consumer fixtures meet the exit criteria in `docs/PROJECT_PLAN.md`.
