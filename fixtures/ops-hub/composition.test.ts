import { describe, expect, it } from "vitest";

import {
  createFakeOpsHubDomain,
  createOpsHubComposition,
  runOpsHubGitHubOccurrence,
  runOpsHubHealthOccurrence,
} from "./composition.js";

const T0 = "2026-07-31T12:00:00.000Z";
const T1 = "2026-07-31T12:01:00.000Z";
const T2 = "2026-07-31T12:10:00.000Z";

describe("ops-hub consumer fixture", () => {
  it("compiles a Cloudflare route map and advances health checkpoints", async () => {
    const domain = createFakeOpsHubDomain();
    const composition = createOpsHubComposition({ domain });

    const first = await runOpsHubHealthOccurrence(composition, T0);
    expect(first.outcome).toBe("succeeded");
    if (first.outcome === "succeeded") {
      expect(first.state.checkpoint).toBe("targets:2");
      expect(first.result.summary).toEqual({ probed: 2 });
    }

    const second = await runOpsHubHealthOccurrence(composition, T1);
    expect(second.outcome).toBe("succeeded");
    if (second.outcome === "succeeded") {
      expect(second.state.checkpoint).toBeUndefined();
    }

    expect(domain.probeCalls).toBe(2);
    await expect(
      composition.scheduler.getState("health.probe-targets"),
    ).resolves.toMatchObject({ status: "succeeded" });
  });

  it("keeps GitHub sync state independent of health probes", async () => {
    const domain = createFakeOpsHubDomain();
    const composition = createOpsHubComposition({ domain });

    await runOpsHubHealthOccurrence(composition, T0);
    const sync = await runOpsHubGitHubOccurrence(composition, T2);
    expect(sync.outcome).toBe("succeeded");
    if (sync.outcome === "succeeded") {
      expect(sync.state.checkpoint).toBe("orgs:1");
      expect(sync.state.taskId).toBe("github.sync-orgs");
    }

    await expect(
      composition.scheduler.getState("health.probe-targets"),
    ).resolves.toMatchObject({ checkpoint: "targets:2" });
    expect(domain.syncCalls).toBe(1);
  });

  it("suppresses overlap for a live health lease", async () => {
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const domain = {
      probeCalls: 0,
      syncCalls: 0,
      async probeTargets() {
        this.probeCalls += 1;
        if (this.probeCalls === 1) {
          entered?.();
          await gate;
        }
        return { probed: 1, nextCursor: null };
      },
      async syncOrgs() {
        this.syncCalls += 1;
        return { orgsSynced: 0, nextCursor: null };
      },
    };

    const store = createOpsHubComposition().store;
    const a = createOpsHubComposition({
      store,
      workerId: "worker-a",
      domain,
    });
    const b = createOpsHubComposition({
      store,
      workerId: "worker-b",
      domain,
    });

    const first = runOpsHubHealthOccurrence(a, T0);
    await enteredGate;
    const second = await runOpsHubHealthOccurrence(b, T0);
    expect(second).toMatchObject({ outcome: "skipped", reason: "live_lease" });
    release?.();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded" });
    expect(domain.probeCalls).toBe(1);
  });
});
