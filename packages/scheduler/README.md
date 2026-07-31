# @pegma/scheduler

Durable coordination for host-triggered recurring work.

> [!IMPORTANT]
> This package is under active development and is not published or usable in
> production yet. Version `0.0.0` is a repository-development placeholder,
> not an advertised release.

Phase 1 provides the public task/checkpoint contracts, validated static task
registration, and the scheduler-owned durable state collection. The runner
that claims and executes tasks arrives in Phase 2.

The host still owns the actual wakeup: Cloudflare Cron Triggers, an Azure
Functions timer, a Kubernetes CronJob, or a local development driver. This
package will never pretend a library can guarantee that infrastructure fires.

## Phase 1 surface

```ts
import { defineScheduledTasks } from "@pegma/scheduler";

const tasks = defineScheduledTasks({
  "support.mail.send": async ({ checkpoint }) => {
    const page = await mailWorker.runSendPage({
      limit: 50,
      ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
    });
    return { nextCheckpoint: page.nextCursor };
  },
});
```

Task names are explicit static identifiers. A string checkpoint advances one
scan cycle, `null` closes it, and omission leaves it unchanged. Checkpoints are
opaque and belong only to the task that produced them.

See the repository [architecture](../../docs/ARCHITECTURE.md),
[consumer evidence](../../docs/CONSUMER_REQUIREMENTS.md), and
[project plan](../../docs/PROJECT_PLAN.md).
