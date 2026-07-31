# Release operations

Scheduler is intentionally not releasable in Phase 1. There is no publish
workflow or release script yet, and `0.0.0` is not an advertised version.

Before adding release automation:

1. Complete the Phase 2 runner and adversarial tests.
2. Complete real Azurite and D1 verification.
3. Complete Ops Hub and Support Desk consumer fixtures
   (`fixtures/ops-hub`, `fixtures/support-desk`, plus Azure reference under
   `fixtures/azure-functions`).
4. Complete a focused security review.
5. Refresh exact Pegma dependency pins from `https://pegma.dev/catalog.json`.

The eventual lane must match current Pegma release rules:

- protected `main` branch;
- protected signed annotated `vX.Y.Z` tag already on `origin/main`;
- `gh release create vX.Y.Z --verify-tag`;
- unprivileged gate and exact tarball preparation;
- minimal publish job with npm trusted-publisher OIDC only;
- provenance enabled and no token fallback;
- package-local README and LICENSE;
- `prepack` build and test files excluded from `dist`.

A first package-name bootstrap, if npm still requires it, must be isolated from
the normal release lane and must never make `0.0.x` the advertised supported
release.
