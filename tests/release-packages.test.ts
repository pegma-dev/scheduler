import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELEASE_PACKAGES,
  decidePublication,
  isNormalReleaseVersion,
  lockDependencyMatches,
  parseArguments,
  parsePnpmLockfileImporters,
} from "../scripts/release-packages.mjs";

describe("release package metadata", () => {
  it("accepts npm's cross-platform argument separator", () => {
    expect(parseArguments(["--", "--output", ".release"])).toEqual({
      output: ".release",
    });
  });

  it("keeps the exact public package inventory in dependency order", () => {
    expect(RELEASE_PACKAGES.map(({ name }) => name)).toEqual([
      "@pegma/scheduler",
      "@pegma/scheduler-cloudflare",
    ]);
  });

  it("ships the synchronized 0.1.0 package set with exact internal pins", () => {
    const manifests = RELEASE_PACKAGES.map(({ directory }) =>
      JSON.parse(
        readFileSync(
          join(process.cwd(), "packages", directory, "package.json"),
          "utf8",
        ),
      ),
    ) as Array<{
      name: string;
      version: string;
      dependencies?: Record<string, string>;
    }>;

    expect(manifests.map(({ name, version }) => ({ name, version }))).toEqual([
      { name: "@pegma/scheduler", version: "0.1.0" },
      { name: "@pegma/scheduler-cloudflare", version: "0.1.0" },
    ]);
    expect(manifests[1]?.dependencies?.["@pegma/scheduler"]).toBe("0.1.0");
  });

  it("rejects the bootstrap range from the normal release lane", () => {
    expect(isNormalReleaseVersion("0.0.0")).toBe(false);
    expect(isNormalReleaseVersion("0.0.1")).toBe(false);
    expect(isNormalReleaseVersion("0.1.0")).toBe(true);
    expect(isNormalReleaseVersion("1.0.0")).toBe(true);
  });

  it("pins pnpm as the workspace package manager", () => {
    const manifest = JSON.parse(
      readFileSync(join(process.cwd(), "package.json"), "utf8"),
    ) as { packageManager?: string };
    expect(manifest.packageManager).toBe("pnpm@10.34.5");
    expect(existsSync(join(process.cwd(), "pnpm-lock.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "pnpm-workspace.yaml"))).toBe(true);
    expect(existsSync(join(process.cwd(), "package-lock.json"))).toBe(false);
    expect(existsSync(join(process.cwd(), "yarn.lock"))).toBe(false);
  });

  it("reads workspace inventory and link pins from pnpm-lock.yaml", () => {
    const importers = parsePnpmLockfileImporters(`importers:

  .:
    devDependencies:
      prettier:
        specifier: ^3.9.6
        version: 3.9.6

  packages/scheduler:
    dependencies:
      '@pegma/spine':
        specifier: 0.1.2
        version: 0.1.2
      '@pegma/storage-core':
        specifier: 0.4.0
        version: 0.4.0

  packages/scheduler-cloudflare:
    dependencies:
      '@pegma/scheduler':
        specifier: 0.1.0
        version: link:../scheduler

packages:
  prettier@3.9.6:
    resolution: {integrity: sha512-example}
`);
    expect(Object.keys(importers)).toEqual([
      ".",
      "packages/scheduler",
      "packages/scheduler-cloudflare",
    ]);
    expect(importers["packages/scheduler"]).toEqual({
      dependencies: {
        "@pegma/spine": { specifier: "0.1.2", version: "0.1.2" },
        "@pegma/storage-core": { specifier: "0.4.0", version: "0.4.0" },
      },
    });
    expect(
      importers["packages/scheduler-cloudflare"]?.dependencies?.[
        "@pegma/scheduler"
      ],
    ).toEqual({
      specifier: "0.1.0",
      version: "link:../scheduler",
    });

    const live = parsePnpmLockfileImporters(
      readFileSync(join(process.cwd(), "pnpm-lock.yaml"), "utf8"),
    );
    expect(
      live["packages/scheduler-cloudflare"]?.dependencies?.["@pegma/scheduler"],
    ).toEqual({
      specifier: "0.1.0",
      version: "link:../scheduler",
    });
    expect(
      lockDependencyMatches(
        live["packages/scheduler"]?.dependencies?.["@pegma/spine"],
        "0.1.2",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/scheduler"]?.dependencies?.["@pegma/storage-core"],
        "0.4.0",
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        live["packages/scheduler-cloudflare"]?.dependencies?.[
          "@pegma/scheduler"
        ],
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(true);
  });

  it("matches each lockfile dependency to its own specifier and resolved version", () => {
    const spine = { specifier: "0.1.2", version: "0.1.2" };
    const storage = { specifier: "0.4.0", version: "0.4.0" };
    expect(lockDependencyMatches(spine, "0.1.2")).toBe(true);
    expect(lockDependencyMatches(storage, "0.4.0")).toBe(true);
    expect(lockDependencyMatches(spine, "0.4.0")).toBe(false);
    expect(lockDependencyMatches(storage, "0.1.2")).toBe(false);
    expect(
      lockDependencyMatches({ specifier: "0.1.2", version: "999.0.0" }, "0.1.2"),
    ).toBe(false);
    expect(
      lockDependencyMatches(
        { specifier: "0.1.0", version: "link:../scheduler" },
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(true);
    expect(
      lockDependencyMatches(
        { specifier: "0.1.0", version: "0.1.0" },
        "0.1.0",
        { workspace: true },
      ),
    ).toBe(false);
  });

  it("keeps pack, registry view, and publish on the npm CLI", () => {
    const source = readFileSync(
      join(process.cwd(), "scripts/release-packages.mjs"),
      "utf8",
    );
    expect(source).not.toMatch(
      /(?:npmExecPath|npm_execpath)\s*(?:\?\?|===|!==)/u,
    );
    expect(source).toMatch(
      /function runNpm\([\s\S]*?process\.platform === "win32" \? "npm\.cmd" : "npm"/u,
    );
  });

  it("skips a byte-identical existing version", () => {
    const integrity =
      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    expect(decidePublication(integrity, integrity)).toBe("skip");
    expect(decidePublication(integrity, null)).toBe("publish");
  });
});
