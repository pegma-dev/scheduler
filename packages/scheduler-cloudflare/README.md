# @pegma/scheduler-cloudflare

Explicit Cloudflare Cron Trigger dispatch for
[`@pegma/scheduler`](https://github.com/pegma-dev/scheduler).

> [!IMPORTANT]
> This package is under active development and is not published or usable in
> production yet. Version `0.0.0` is a repository-development placeholder,
> not an advertised release.

The adapter translates a Cloudflare `ScheduledController` into core
`runScheduled` calls through a **host-supplied cron route map**. It does not
own D1, Wrangler configuration, task discovery, or domain work.

```ts
import { createScheduler, defineScheduledTasks } from "@pegma/scheduler";
import { createCloudflareSchedulerDispatch } from "@pegma/scheduler-cloudflare";
import { createCloudflareD1Store } from "@pegma/storage-cloudflare-d1";

const tasks = defineScheduledTasks({
  "health.probe-targets": async () => ({ more: false }),
  "github.sync-orgs": async ({ checkpoint }) => {
    // bounded domain page
    return { nextCheckpoint: checkpoint ?? "page-1" };
  },
});

const scheduler = createScheduler({
  store: createCloudflareD1Store({ database: env.DB }),
  clock,
  logger,
  instanceId: "ops-hub",
  workerId: env.WORKER_ID ?? "worker-1",
  tasks,
});

const dispatch = createCloudflareSchedulerDispatch({
  scheduler,
  routes: {
    "* * * * *": ["health.probe-targets"],
    "*/10 * * * *": ["github.sync-orgs"],
  },
});

export default {
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext,
  ) {
    await dispatch.scheduled(controller, ctx);
  },
};
```

## Contracts

- Route keys must match Wrangler cron expressions **exactly**.
- `controller.scheduledTime` becomes the trusted `scheduledFor` ISO timestamp.
- `ctx.waitUntil` keeps the isolate alive for the full dispatch promise.
- Unmapped cron expressions fail closed.
- Multiple tasks may share one expression; each keeps independent durable state.

## Local development

```sh
npx wrangler dev --test-scheduled --persist-to .wrangler/state
curl "http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*"
```

Persist `.wrangler/state` (for example as a Docker volume) so D1 and scheduler
task state survive restarts. A Docker-side timer that hits `/__scheduled` every
30 seconds is a development wakeup only; production still uses Cron Triggers.

See the repository [Cloudflare guide](../../docs/CLOUDFLARE.md) and
[project plan](../../docs/PROJECT_PLAN.md).
