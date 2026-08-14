# Release operations

There are exactly two publication paths:

1. a one-time manual bootstrap of `@pegma/scheduler@0.0.0` and
   `@pegma/scheduler-cloudflare@0.0.0` (**done**; dist-tag `bootstrap` only;
   that immutable pre-pnpm tag remains an npm-era receipt); and
2. every advertised release, beginning with `0.1.0` (**published**), through the
   environment-protected GitHub OIDC workflow in
   [`.github/workflows/publish.yml`](../.github/workflows/publish.yml).

The normal release lane rejects the entire `0.0.x` range. Bootstrap artifacts
remain non-advertised.

## Common source requirements

Every advertised artifact comes from a protected, signed, annotated `vX.Y.Z`
tag whose commit is already contained in `origin/main`. Configure:

- the protected `npm-publish` GitHub environment;
- repository variable `RELEASE_ALLOWED_SIGNERS` with reviewed SSH allowed-signers
  entries; and
- tag protection against moving or deleting `v*`.

npm trusted publishers for both packages must identify:

- organization `pegma-dev`
- repository `scheduler`
- workflow filename `publish.yml`
- environment `npm-publish`
- allowed action `npm publish`

Run `pnpm run format:check`, `pnpm run check`, and `pnpm test` on Node 22 and 24
before tagging. Never unpublish and reuse a version.

## Normal OIDC releases (`0.1.0` and later)

1. Land a reviewed PR that sets both public packages (and `pnpm-lock.yaml` /
   fixture pins) to the same stable version, and updates release notes.
2. After merge to `main`, create a **protected signed annotated** tag:

   ```sh
   git checkout main
   git pull --ff-only origin main
   git tag -s v0.1.0 -m "v0.1.0"
   git push origin v0.1.0
   ```

3. Create a GitHub release from that tag (this starts the publish workflow):

   ```sh
   gh release create v0.1.0 --verify-tag --title "v0.1.0" --notes-file docs/RELEASE_NOTES.md
   ```

4. The workflow:
   - verifies the signed tag against `RELEASE_ALLOWED_SIGNERS`;
   - runs the full gate;
   - packs both packages with `pnpm run release:pack` (npm CLI for `pack` /
     registry `view`);
   - publishes exact tarballs with provenance via OIDC
     (`node scripts/release-packages.mjs publish`). The OIDC job does not
     download Corepack pnpm.

Local helpers (never substitute for the OIDC lane for advertised releases):

```sh
pnpm run release:check
pnpm run release:pack -- --output .release
# release:publish is restricted to the GitHub release workflow
```

## After a release lands

Confirm:

```sh
npm dist-tag ls @pegma/scheduler
npm dist-tag ls @pegma/scheduler-cloudflare
npm view @pegma/scheduler version
```

For `0.1.0`, `latest` is `0.1.0` and `bootstrap` remains `0.0.0`. Unqualified
install resolves to the advertised version.
