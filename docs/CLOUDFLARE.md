# Cloudflare and local Wrangler guidance

## Production boundary

Cloudflare owns Cron Trigger delivery and the host owns `wrangler.jsonc`.
Production cron expressions have five fields and one-minute resolution. A
30-second production cadence is therefore outside Cloudflare Cron Triggers.

The planned adapter receives a `ScheduledController` and dispatches its `cron`
value through a static host map. Multiple tasks may intentionally share one
cron expression; each retains independent durable state.

```ts
const routes = {
  "* * * * *": ["health.probe-targets"],
  "*/10 * * * *": ["github.sync-orgs"],
} as const;
```

The same expression must appear in Wrangler configuration. The adapter does
not mutate deployment configuration or discover it.

## Local Docker

Run Wrangler with scheduled-event testing enabled:

```sh
npx wrangler dev --test-scheduled --persist-to .wrangler/state
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

1. Core tests invoke tasks directly against Memory Store.
2. Adapter tests construct scheduled controller inputs without a network.
3. Wrangler integration tests call `/__scheduled` against local D1.
4. A green Ops Hub fixture proves Docker volume and repeated trigger behavior.

References:

- <https://developers.cloudflare.com/workers/configuration/cron-triggers/>
- <https://developers.cloudflare.com/workers/examples/cron-trigger/>
