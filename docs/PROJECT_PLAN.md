# Scheduler Project Plan

## Status

**Stage:** Phase 0 requirements validation and Phase 1 repository foundation
are complete in source. No package is published or production-usable.

**Trigger:** Ops Hub and Support Desk independently need the same explicit,
durable coordination boundary for recurring work.

**Initial package:** `@pegma/scheduler`, currently `0.0.0` as an unpublished
development placeholder.

**Current exact dependencies:** `@pegma/spine@0.1.2` and
`@pegma/storage-core@0.4.0`, refreshed from the Pegma catalog on 2026-07-31.
Refresh the catalog again before any consumer integration or release.

## Vision

Provide the small piece that host timers do not: portable, durable coordination
of explicitly registered recurring work. A fresh agent should be able to read
the task contract, one state machine, and adversarial tests and wire it
correctly without learning a scheduler service.

## Product intent

Scheduler is for convergence-oriented recurring loops: scan another page,
refresh a projection, poll a provider, or run a health probe. It is not a
workflow engine or durable arbitrary job queue.

## Package architecture

| Package                       | Responsibility                                  | Earliest phase |
| ----------------------------- | ----------------------------------------------- | -------------- |
| `@pegma/scheduler`            | Static tasks, durable state, runner, inspection | Phase 1        |
| `@pegma/scheduler-cloudflare` | Explicit Cron Trigger dispatch                  | Phase 3        |

Do not create another adapter package before implementation and repeated
consumer behavior justify it.

## Delivery phases

### Phase 0 — consumer validation (complete)

- Validate Ops Hub timed health and GitHub synchronization needs.
- Inventory Support Desk mail, repair, and retention loops.
- Separate host wakeups, scheduler coordination, and domain safety.
- Establish Cloudflare local/Docker constraints.

Exit evidence is recorded in `CONSUMER_REQUIREMENTS.md`.

### Phase 1 — repository and durable contracts (complete)

- Initialize the repository on a `claude/*` branch.
- Add the first real `@pegma/scheduler` package.
- Pin exact Spine and Storage Core dependencies.
- Define the task context/result contracts and static registry.
- Define and validate `scheduler.task-state.v1`.
- Add package README/LICENSE and test exclusion.
- Add CI, contribution, security, architecture, consumer, Cloudflare, testing,
  and release guidance.

**Exit criterion:** the package builds, its stored state round-trips, malformed
registrations and state fail closed, and the full local gate passes.

### Phase 2 — durable runner

- Implement `createScheduler` over an injected Store, Clock, and Logger.
- Claim with Storage Core `update` and a unique fencing token.
- Enforce bounded leases and expired-claim recovery.
- Implement scheduled and manual invocation.
- Advance checkpoints only after successful fenced completion.
- Refuse stale/out-of-order scheduled completion.
- Persist safe status and emit fixed structured events.
- Implement keyed state inspection.
- Complete the adversarial matrix in `TESTING.md`.

**Exit criterion:** concurrency, crash, replay, stale-worker, and checkpoint
tests pass against Memory Store and Azurite.

### Phase 3 — Cloudflare adapter and local story

- Implement `@pegma/scheduler-cloudflare` only when work begins.
- Dispatch `ScheduledController.cron` through an explicit typed route map.
- Prove `scheduledTime` handling and `waitUntil` behavior.
- Document Wrangler `--test-scheduled`, `/__scheduled`, persistent local D1,
  and the Docker-side 30-second development driver.
- Test against real local D1.

**Exit criterion:** a synthetic Worker fixture survives restart, repeated
events, overlap, and a complete checkpoint cycle against persistent local D1.

### Phase 4 — consumer integration

- Compose Ops Hub health probing and GitHub synchronization.
- Compose Support Desk mail send/reconciliation/retention and queue repair.
- Add an Azure Functions reference composition for RetireGolden.
- Keep receipt-bucket and principal iteration inside Support Desk drivers.
- Feed integration friction back into the contracts before release.

**Exit criterion:** both independent consumers compile against exact package
pins and their integration tests prove real scheduled work.

### Phase 5 — first advertised release

- Complete focused security review and package inventory verification.
- Add signed-tag/OIDC release automation following current Pegma practice.
- Perform the one-time package-name bootstrap if npm requires it.
- Publish `0.1.0` only from a protected signed annotated tag.
- Add the component and a green synthetic recipe to `pegma.dev`.

## Non-goals

- cron parsing, calendars, DST, or timezone policy;
- one-time delayed arbitrary jobs;
- workflow graphs or task dependencies;
- exactly-once side effects;
- dynamic discovery or user-authored executable tasks;
- owning a Store or provider/runtime SDK in core;
- domain retries, outboxes, or retention policy;
- a hosted scheduler service or control plane.

## Open questions for Phase 2

- Whether scheduled occurrence suppression keys solely on `scheduledFor` or
  also retains a bounded host occurrence identifier.
- The default lease duration and maximum accepted lease.
- Whether manual runs bypass monotonic scheduled occurrence suppression while
  still sharing the same task lease.
- Whether safe numeric summaries belong only in logs or in durable last-run
  inspection state.
