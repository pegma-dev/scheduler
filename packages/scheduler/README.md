# @pegma/scheduler

Durable coordination for host-triggered recurring work.

> [!IMPORTANT]
> This package is under active development and is not published or usable in
> production yet. Version `0.0.0` is a repository-development placeholder,
> not an advertised release.

Phase 2 provides the durable runner: claim, bounded leases, scheduled and
manual invocation, fenced checkpoint advancement, safe run state, and keyed
inspection. The host still owns the wakeup.

```ts
import { fixedClock, noopLogger } from "@pegma/spine";
import { createMemoryStore } from "@pegma/storage-core";
import { createScheduler, defineScheduledTasks } from "@pegma/scheduler";

const tasks = defineScheduledTasks({
  "support.mail.send": async ({ checkpoint }) => {
    const page = await mailWorker.runSendPage({
      limit: 50,
      ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
    });
    return { nextCheckpoint: page.nextCursor };
  },
});

const scheduler = createScheduler({
  store: createMemoryStore(),
  clock: fixedClock("2026-07-31T12:00:00.000Z"),
  logger: noopLogger,
  instanceId: "retiregolden-support",
  workerId: "worker-1",
  tasks,
});

await scheduler.runScheduled("support.mail.send", {
  scheduledFor: "2026-07-31T12:00:00.000Z",
  invocationId: "invocation-1",
});
```

## Contracts

- Task names are explicit static identifiers registered at the composition root.
- A string checkpoint advances one scan cycle, `null` closes it, and omission
  leaves it unchanged.
- Scheduled occurrences are suppressed when `scheduledFor` is not strictly
  newer than the last accepted scheduled occurrence.
- Manual runs bypass occurrence suppression but share the same task lease.
- Execution is at-least-once: a crash after a side effect and before fenced
  completion can repeat work. Domain operations must be idempotent.
- Handler `summary` values are logged only; they are not durable inspection
  state in `0.1`.
- Default lease is 30 seconds; the maximum accepted lease is 24 hours. The
  handler timeout defaults to the lease minus one second of completion headroom
  when the lease is longer than one second; shorter leases default to the full
  claim budget. After claim I/O the runner re-samples the clock and runs the
  handler only when more than one second of lease remains, capping the timeout
  to remaining lease minus that headroom.

See the repository [architecture](../../docs/ARCHITECTURE.md),
[consumer evidence](../../docs/CONSUMER_REQUIREMENTS.md),
[testing matrix](../../docs/TESTING.md), and
[project plan](../../docs/PROJECT_PLAN.md).
