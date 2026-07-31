# Release notes

## 0.1.0 — first advertised release

First supported publication of:

- `@pegma/scheduler`
- `@pegma/scheduler-cloudflare`

### Included

- Static task registry and durable `scheduler.task-state.v1` collection
- `createScheduler` durable runner (claims, leases, checkpoints, inspection)
- Adversarial Memory Store and Azurite coverage
- Cloudflare Cron Trigger dispatch with real local D1 fixture tests
- Independent consumer fixtures for Ops Hub, Support Desk, and Azure Functions shapes

### Install

```sh
npm install @pegma/scheduler@0.1.0
npm install @pegma/scheduler-cloudflare@0.1.0
```

### Notes

- Execution is at-least-once; domain work must be idempotent.
- `0.0.0` was a non-advertised package-name bootstrap only.
- Hosts own timer delivery (Cloudflare Cron Triggers, Azure timers, local drivers).
