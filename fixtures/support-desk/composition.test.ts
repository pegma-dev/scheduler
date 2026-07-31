import { describe, expect, it } from "vitest";

import {
  createFakeSupportDeskDomain,
  createSupportDeskComposition,
} from "./composition.js";

const T0 = "2026-07-31T12:00:00.000Z";
const T1 = "2026-07-31T12:05:00.000Z";
const T2 = "2026-07-31T12:10:00.000Z";

describe("support-desk consumer fixture", () => {
  it("registers the five direct host loops and advances mail.send checkpoints", async () => {
    const domain = createFakeSupportDeskDomain();
    const composition = createSupportDeskComposition({ domain });

    const first = await composition.runScheduled("mail.send", T0);
    expect(first.outcome).toBe("succeeded");
    if (first.outcome === "succeeded") {
      expect(first.state.checkpoint).toBe("send:1");
    }

    const second = await composition.runScheduled("mail.send", T1);
    expect(second.outcome).toBe("succeeded");
    if (second.outcome === "succeeded") {
      expect(second.state.checkpoint).toBeUndefined();
    }

    expect(domain.calls["mail.send"]).toBe(2);
  });

  it("keeps independent checkpoints across mail and queue loops", async () => {
    const domain = createFakeSupportDeskDomain();
    const composition = createSupportDeskComposition({ domain });

    await composition.runScheduled("mail.send", T0);
    await composition.runScheduled("queue.repair", T0);
    await composition.runScheduled("mail.reconcile", T0);
    await composition.runScheduled("mail.terminal-sweep", T0);
    await composition.runScheduled("queue.inactive-sweep", T0);

    await expect(
      composition.scheduler.getState("mail.send"),
    ).resolves.toMatchObject({ checkpoint: "send:1" });
    await expect(
      composition.scheduler.getState("queue.repair"),
    ).resolves.toMatchObject({ checkpoint: "repair:1" });
    await expect(
      composition.scheduler.getState("mail.reconcile"),
    ).resolves.toMatchObject({ checkpoint: "reconcile:1" });
    await expect(
      composition.scheduler.getState("mail.terminal-sweep"),
    ).resolves.toMatchObject({ checkpoint: "terminal:1" });
    await expect(
      composition.scheduler.getState("queue.inactive-sweep"),
    ).resolves.toMatchObject({ checkpoint: "inactive:1" });

    expect(Object.keys(domain.calls).sort()).toEqual([
      "mail.reconcile",
      "mail.send",
      "mail.terminal-sweep",
      "queue.inactive-sweep",
      "queue.repair",
    ]);
  });

  it("does not invent dynamic receipt-bucket tasks", async () => {
    const composition = createSupportDeskComposition();
    await expect(
      // @ts-expect-error receipt sweeps stay host-selected drivers
      composition.runScheduled("receipt.inbound.bucket-a", T2),
    ).rejects.toThrow(/not registered/);
  });

  it("proves failure retains the mail.send checkpoint", async () => {
    const domain = createFakeSupportDeskDomain();
    const composition = createSupportDeskComposition({ domain });
    await composition.runScheduled("mail.send", T0);

    const failing = createSupportDeskComposition({
      store: composition.store,
      domain: {
        ...domain,
        async runSendPage() {
          throw new Error("provider unavailable token=secret");
        },
      },
      workerId: "failing-worker",
    });

    const failed = await failing.runScheduled("mail.send", T1);
    expect(failed.outcome).toBe("failed");
    if (failed.outcome === "failed") {
      expect(failed.state.checkpoint).toBe("send:1");
      expect(JSON.stringify(failed.state)).not.toMatch(/secret/);
    }
  });
});
