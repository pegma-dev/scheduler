import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import {
  RELEASE_PACKAGES,
  decidePublication,
  isNormalReleaseVersion,
  parseArguments,
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

  it("skips a byte-identical existing version", () => {
    const integrity =
      "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==";
    expect(decidePublication(integrity, integrity)).toBe("skip");
    expect(decidePublication(integrity, null)).toBe("publish");
  });
});
