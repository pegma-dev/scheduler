# Consumer fixtures

Independent host compositions that declare exact dependency pins in each
fixture `package.json` (`@pegma/scheduler@0.1.0`, and for Ops Hub also
`@pegma/scheduler-cloudflare@0.1.0`) against the monorepo workspaces and prove
real scheduled work.

These fixtures are the Phase 4 integration bar described in
`docs/RELEASING.md`. They deliberately do **not** import Ops Hub or Support
Desk application packages: Ops Hub is still bootstrap-only, and Support Desk
domain APIs stay outside this repository. Each fixture mirrors the host task
names and bounded-page shapes documented in those consumers.

| Fixture           | Mirrors                                                       |
| ----------------- | ------------------------------------------------------------- |
| `ops-hub`         | Health probes + GitHub org sync on Cloudflare Cron routes     |
| `support-desk`    | Mail send/reconcile/sweep + queue repair/inactive-sweep loops |
| `azure-functions` | Timer-trigger composition for a RetireGolden-style Azure host |

Run with the repository gate (`npm test`). External consumers should pin the
first advertised release (`0.1.0`) from npm after the signed `v0.1.0` OIDC
publish completes.
