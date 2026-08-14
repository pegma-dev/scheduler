# Cloudflare and local Wrangler guidance

## Production boundary

Cloudflare owns Cron Trigger delivery and the host owns `wrangler.jsonc`.
Production cron expressions have five fields and one-minute resolution. A
30-second production cadence is therefore outside Cloudflare Cron Triggers.

`@pegma/scheduler-cloudflare` receives a `ScheduledController` and dispatches
its `cron` value through a static host map. Multiple tasks may intentionally
share one cron expression; each retains independent durable state.

```ts
import { createCloudflareSchedulerDispatch } from "@pegma/scheduler-cloudflare";

const dispatch = createCloudflareSchedulerDispatch({
  scheduler,
  routes: {
    "* * * * *": ["health.probe-targets"],
    "*/10 * * * *": ["github.sync-orgs"],
  },
});

export default {
  async scheduled(controller, env, ctx) {
    // waitUntil is registered inside the adapter when ctx is passed.
    await dispatch.scheduled(controller, ctx);
  },
};
```

The same expression must appear in Wrangler configuration. The adapter does
not mutate deployment configuration or discover it. Unmapped cron values fail
closed.

`controller.scheduledTime` (Unix milliseconds) becomes the trusted
`scheduledFor` ISO timestamp for durable occurrence suppression.

## Local Docker

Run Wrangler with scheduled-event testing enabled:

```sh
pnpm dlx wrangler dev --test-scheduled --persist-to .wrangler/state
```

Wrangler exposes `/__scheduled`. A test or Docker-side timer can invoke it:

```sh
curl "http://worker:8787/__scheduled?cron=*+*+*+*+*"
```

For Ops Hub's local-only 30-second health cadence, a tiny Docker service may
call that endpoint every 30 seconds. It is a development wakeup driver; the
task registry, durable lease, checkpoint, and execution behavior remain the
same Scheduler code used by production triggers.

Persist `.wrangler/state` in a Docker volume so scheduler and domain D1 state
survive restarts. Do not treat Memory Store as durability evidence.

## Test layers

1. Core tests invoke tasks directly against Memory Store (and Azurite).
2. Adapter unit tests construct scheduled controller inputs without a network.
3. Cloudflare Vitest pool tests run against real local D1
   (`packages/scheduler-cloudflare/src/fixture.d1.test.ts`).
4. The Ops Hub-shaped fixture under `fixtures/ops-hub` proves Cron route
   composition and scheduled work against Memory Store. Docker volume
   durability and repeated `/__scheduled` triggers remain host/Worker concerns
   once Ops Hub is more than bootstrap.

Run the D1 suite alone:

```sh
pnpm run test:d1
```

References:

- <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- <https://developers.cloudflare.com/workers/examples/cron-trigger/>
