# Architecture

## Boundary

Scheduler coordinates a named recurring invocation after a host runtime wakes
the application. It does not provide the wakeup and does not own the domain
work.

```text
host timer -> runtime adapter -> scheduler claim -> bounded domain handler
                                      |
                                      +-> scheduler task-state collection
```

The host owns cron expressions, timezones, runtime deployment, secrets, and
the composition root. The domain owns retries, idempotency, provider calls,
and business-safe storage transitions.

## Packages

`@pegma/scheduler` is runtime-neutral and takes an injected Storage Core
`Store`, Spine `Clock`, and Spine `Logger` when the Phase 2 runner is built.

`@pegma/scheduler-cloudflare` is deferred until Phase 3. It will translate a
Cloudflare `ScheduledController` into the core invocation contract and route
`controller.cron` through an explicit host-supplied map. It will not own D1,
Wrangler configuration, or task discovery.

Azure begins as a tested composition example. A package is justified only
after repeated adapter behavior appears in a second Azure consumer.

## Static task registry

`defineScheduledTasks` validates canonical task IDs and returns a frozen
null-prototype copy. Literal keys remain available to TypeScript so a future
runner can accept only registered task IDs.

Task IDs are lowercase stable identifiers such as `mail.send` and
`github.sync-orgs`. They are operational contract names, not user input.

## Durable task state

Scheduler owns `scheduler.task-state.v1` because its state does not need to
commit atomically with domain records. The host supplies the Store and adapter.

| Field                               | Meaning                                             |
| ----------------------------------- | --------------------------------------------------- |
| `instanceId`                        | Isolates one deployed composition                   |
| `taskId`                            | Static registered task name                         |
| `status`                            | `running`, `succeeded`, or `failed`                 |
| `checkpoint`                        | Opaque progress from the last successful call       |
| `consecutiveFailures`               | Coarse operational state                            |
| `lastScheduledFor`                  | Latest accepted scheduled occurrence                |
| `lastStartedAt` / `lastCompletedAt` | Trusted host timestamps                             |
| `lastFailureCategory`               | Safe bounded token, never raw error text            |
| lease fields                        | Owner, unique claim token, and expiry while running |

The physical key is `(instanceId, taskId)`. Known task IDs make direct keyed
access sufficient; Scheduler needs no query language or secondary index.

## Planned execution state machine

1. Validate a registered task and canonical invocation input.
2. Use Storage Core `update` to create or claim its row.
3. Skip a live claim or an occurrence no newer than the latest completed one.
4. Mint a unique fencing token and persist a bounded lease.
5. Invoke one bounded handler with the prior checkpoint.
6. On success, update only if the fencing token still owns the row.
7. Advance, clear, or retain the checkpoint according to the result.
8. On failure, retain the checkpoint, clear the lease, and record only a safe
   failure category.
9. An expired claim may be recovered; its stale worker can no longer commit.

The handler may already have produced an external side effect before a crash.
Execution is therefore at-least-once. Domain idempotency is mandatory.

## Checkpoint semantics

- A string becomes the next checkpoint.
- `null` closes a scan cycle, so the next occurrence receives no checkpoint.
- Omitting `nextCheckpoint` retains the existing checkpoint.
- The value is passed through without interpretation.
- It is bounded to 4096 characters and cannot contain controls.
- It may never be shared across task IDs or instance IDs.

`more` is telemetry in `0.1`. The core will not automatically loop because
runtime budgets differ and an unbounded continuation can monopolize a Worker.

## Explicit refusals

- cron parsing or timezone policy;
- an always-on process;
- exactly-once execution;
- arbitrary payload queues or delayed one-off jobs;
- workflow graphs and task dependencies;
- dynamic task discovery or wildcards;
- domain retry or outbox policy;
- provider SDKs in core;
- raw exception persistence;
- guaranteeing that host infrastructure delivers a timer event.
