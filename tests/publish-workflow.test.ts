import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const workflow = readFileSync(
  join(process.cwd(), ".github", "workflows", "publish.yml"),
  "utf8",
);

function job(name: string, next?: string) {
  const start = workflow.indexOf(`  ${name}:\n`);
  const end =
    next === undefined ? workflow.length : workflow.indexOf(`  ${next}:\n`);
  expect(start).toBeGreaterThanOrEqual(0);
  expect(end).toBeGreaterThan(start);
  return workflow.slice(start, end);
}

describe("publish workflow", () => {
  it("authenticates the release tag before repository use", () => {
    const prepare = job("prepare", "smoke");
    const publish = job("publish");
    for (const section of [prepare, publish]) {
      expect(
        section.indexOf("Authenticate the release tag"),
      ).toBeGreaterThanOrEqual(0);
      expect(section.indexOf("Authenticate the release tag")).toBeLessThan(
        section.search(/actions\/checkout|pnpm|npm install|node /u),
      );
      expect(section).toContain('[[ "${RELEASE_PRERELEASE}" != "false" ]]');
      expect(section).toContain("git init --bare");
      expect(section).toContain("fetch --no-tags origin");
      expect(section).toContain("cat-file -t");
      expect(section).toContain("verify-tag");
      expect(section).toContain('"${RELEASE_COMMIT,,}"');
      expect(section).toContain("merge-base --is-ancestor");
    }
  });

  it("checks out only the release commit for preparation", () => {
    const prepare = job("prepare", "smoke");
    expect(prepare).toContain("ref: ${{ github.sha }}");
    expect(prepare).toContain("persist-credentials: false");
    expect(prepare).not.toContain("ref: refs/tags/");
  });

  it("separates package smoke checks from publication", () => {
    const smoke = job("smoke", "publish");
    const publish = job("publish");
    expect(smoke).toContain("needs: prepare");
    expect(smoke).toContain("permissions:\n      contents: read");
    expect(smoke).toContain(
      "MANIFEST_DIGEST: ${{ needs.prepare.outputs.manifest_digest }}",
    );
    expect(smoke).toContain("record.imports");
    expect(smoke).toContain("--registry https://registry.npmjs.org/");
    expect(smoke).not.toContain("< <(node");
    expect(publish).toContain("needs: [prepare, smoke]");
    expect(publish).not.toContain("actions/checkout");
    expect(publish).not.toContain("scripts/release-packages.mjs");
    expect(publish).not.toContain("pnpm");
  });

  it("uploads only visible prepared files and carries the manifest digest", () => {
    const prepare = job("prepare", "smoke");
    expect(prepare).toContain(
      "manifest_digest: ${{ steps.manifest.outputs.digest }}",
    );
    expect(prepare).toContain("include-hidden-files: false");
    expect(prepare).toMatch(
      /Record the package manifest digest[\s\S]*?set -euo pipefail[\s\S]*?\^\[0-9a-f\]\{64\}\$/u,
    );
    expect(workflow).toContain(
      "MANIFEST_DIGEST: ${{ needs.prepare.outputs.manifest_digest }}",
    );
  });

  it("revalidates the complete package digest set before publication", () => {
    const publish = job("publish");
    expect(publish).toContain('createHash("sha256")');
    expect(publish).toContain('createHash("sha1")');
    expect(publish).toContain('createHash("sha512")');
    expect(publish).toContain("timingSafeEqual");
    expect(publish).toContain("record.files");
    expect(publish).toContain("record.imports");
    expect(publish).toContain("record.directory");
  });

  it("keeps step and runner expressions out of job environments", () => {
    const lines = workflow.split(/\r?\n/u);
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index] !== "    env:") continue;
      for (
        index += 1;
        index < lines.length && /^ {6,}\S/u.test(lines[index] ?? "");
        index += 1
      ) {
        expect(lines[index] ?? "").not.toMatch(/\$\{\{\s*(?:runner|steps)\./u);
      }
      index -= 1;
    }
  });
});
