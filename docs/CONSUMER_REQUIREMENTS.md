# Consumer requirements

## Status

Requirements validation completed on 2026-07-31 against two independent
consumers. Their shared needs justify a first-class Pegma component. Their
domain-specific behavior remains outside Scheduler.

## Ops Hub

Ops Hub is a local Docker-only Cloudflare Worker host backed by local D1. It
needs composition-root timed work for:

- site health probes approximately every 30 seconds;
- GitHub organization synchronization every 5 to 15 minutes.

It requires a Cloudflare Cron Trigger bridge and a Wrangler/local-Docker test
story. The 30-second cadence is local-only because Cloudflare's five-field
production cron syntax has one-minute resolution. A Docker-side development
timer may call Wrangler's test scheduled endpoint without becoming a second
application scheduler.

Sources:

- `../../ops-hub/docs/PEGMA_FEEDBACK.md` in the sibling consumer checkout;
- `../../ops-hub/docs/PROJECT_PLAN.md` in the sibling consumer checkout.

## Support Desk

The existing application exposes these host-scheduled loops:

| Task                        | Existing operation              | Progress state                     |
| --------------------------- | ------------------------------- | ---------------------------------- |
| Mail send                   | `runSendPage`                   | Independent opaque cursor          |
| Mail reconciliation         | `runReconciliationPage`         | Independent opaque cursor          |
| Mail terminal retention     | `mail.sweep`                    | Independent opaque cursor          |
| Queue repair                | `repairQueueProjectionPage`     | Independent opaque cursor          |
| Inactive queue sweep        | `sweepInactiveQueueProjections` | Independent opaque cursor          |
| Inbound receipt retention   | `sweepInboundReceipts`          | Host-selected bucket and cutoff    |
| Delivery callback retention | `sweepDeliveryCallbackReceipts` | Host-selected bucket and cutoff    |
| Customer-index pruning      | `pruneCustomerTicketIndex`      | Host-selected principal and cutoff |

The first five are direct Scheduler consumers. Receipt and principal sweeps
need bounded Support Desk driver functions before they become one generic
scheduled task. The scheduler must not invent dynamic tasks for every bucket
or principal.

Inbound mailbox processing is future Support Desk work. If its provider needs
polling, the provider delta token can be a task checkpoint; authenticity,
MIME limits, threading, deduplication, and ticket writes remain Support Desk
responsibilities.

Sources:

- `../../support-desk/docs/HOST_COMPOSITION.md`;
- `../../support-desk/docs/ARCHITECTURE.md`;
- `../../support-desk/docs/PROJECT_PLAN.md`.

## Shared contract

Both consumers need:

- explicit static task registration;
- host-owned timer delivery;
- durable isolated task state;
- overlap suppression and stale completion fencing;
- crash-safe checkpoint advancement;
- bounded invocations;
- manual/local invocation;
- safe operational telemetry.

This closes requirements Phase 0. It does not claim the integration phase is
complete: both consumer fixtures must still compile and run before release.
