import { describe, expect, it } from "vitest";

import {
  createAzureFunctionsComposition,
  createFakeAzureDomain,
} from "./composition.js";

const T0 = "2026-07-31T12:00:00.000Z";
const T1 = "2026-07-31T13:00:00.000Z";

describe("azure-functions consumer fixture", () => {
  it("runs a timer occurrence and advances the projection checkpoint", async () => {
    const domain = createFakeAzureDomain();
    const composition = createAzureFunctionsComposition({ domain });

    const first = await composition.onTimer(T0);
    expect(first.outcome).toBe("succeeded");
    if (first.outcome === "succeeded") {
      expect(first.state.checkpoint).toBe("proj:25");
    }

    const second = await composition.onTimer(T1);
    expect(second.outcome).toBe("succeeded");
    if (second.outcome === "succeeded") {
      expect(second.state.checkpoint).toBeUndefined();
      expect(second.state.lastScheduledFor).toBe(T1);
    }

    expect(domain.refreshes).toBe(2);
  });

  it("suppresses a stale timer redelivery", async () => {
    const composition = createAzureFunctionsComposition();
    await composition.onTimer(T1);
    const stale = await composition.onTimer(T0);
    expect(stale).toMatchObject({
      outcome: "skipped",
      reason: "stale_occurrence",
    });
  });
});
