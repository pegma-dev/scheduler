import { TableClient } from "@azure/data-tables";
import { createAzureTablesStore } from "@pegma/storage-azure-tables";
import { fixedClock, type IsoTimestamp, noopLogger } from "@pegma/spine";
import { describe, expect, it } from "vitest";

import { TABLE_PORT } from "../../../test/azurite.js";
import { createScheduler, defineScheduledTasks } from "./index.js";

/**
 * Azurite's well-known development credentials. Published emulator defaults;
 * they grant access only to the local process.
 */
const ACCOUNT = "devstoreaccount1";
const KEY =
  "Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==";
const CONNECTION_STRING = [
  "DefaultEndpointsProtocol=http",
  `AccountName=${ACCOUNT}`,
  `AccountKey=${KEY}`,
  `TableEndpoint=http://127.0.0.1:${TABLE_PORT}/${ACCOUNT};`,
].join(";");

const T0 = "2026-07-31T12:00:00.000Z" as IsoTimestamp;
const T1 = "2026-07-31T12:01:00.000Z" as IsoTimestamp;
const T2 = "2026-07-31T12:02:00.000Z" as IsoTimestamp;

let tableCounter = 0;

function freshStore() {
  tableCounter += 1;
  const table = `pegsched${tableCounter}t${process.pid}`;
  const client = TableClient.fromConnectionString(CONNECTION_STRING, table, {
    allowInsecureConnection: true,
  });
  return createAzureTablesStore({ client });
}

describe("createScheduler against Azurite", () => {
  it("completes a checkpoint cycle with overlap suppression", async () => {
    const store = freshStore();
    const tasks = defineScheduledTasks({
      "github.sync-orgs": async ({ checkpoint }) => {
        if (checkpoint === undefined) {
          return { nextCheckpoint: "page-1" };
        }
        if (checkpoint === "page-1") {
          return { nextCheckpoint: null };
        }
        return {};
      },
    });
    const scheduler = createScheduler({
      store,
      clock: fixedClock(T0),
      logger: noopLogger,
      instanceId: "retiregolden-support",
      workerId: "azure-worker",
      tasks,
      leaseMilliseconds: 5_000,
      handlerTimeoutMilliseconds: 4_000,
    });

    const first = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "az-1",
    });
    expect(first.outcome).toBe("succeeded");
    if (first.outcome === "succeeded") {
      expect(first.state.checkpoint).toBe("page-1");
    }

    const second = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T2,
      invocationId: "az-2",
    });
    expect(second.outcome).toBe("succeeded");
    if (second.outcome === "succeeded") {
      expect(second.state.checkpoint).toBeUndefined();
      expect(second.state.lastScheduledFor).toBe(T2);
    }

    const stale = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "az-stale",
    });
    expect(stale).toMatchObject({
      outcome: "skipped",
      reason: "stale_occurrence",
    });

    await expect(scheduler.getState("github.sync-orgs")).resolves.toMatchObject(
      {
        status: "succeeded",
        lastScheduledFor: T2,
      },
    );
  });

  it("fences concurrent workers so only one claim succeeds", async () => {
    const store = freshStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let starts = 0;
    const tasks = defineScheduledTasks({
      "health.probe-targets": async () => {
        starts += 1;
        if (starts === 1) {
          entered?.();
          await gate;
        }
        return { summary: { targets: 1 } };
      },
    });

    const a = createScheduler({
      store,
      clock: fixedClock(T0),
      logger: noopLogger,
      instanceId: "ops-hub",
      workerId: "worker-a",
      tasks,
      leaseMilliseconds: 10_000,
      handlerTimeoutMilliseconds: 9_000,
    });
    const b = createScheduler({
      store,
      clock: fixedClock(T0),
      logger: noopLogger,
      instanceId: "ops-hub",
      workerId: "worker-b",
      tasks,
      leaseMilliseconds: 10_000,
      handlerTimeoutMilliseconds: 9_000,
    });

    const first = a.runScheduled("health.probe-targets", {
      scheduledFor: T1,
      invocationId: "a",
    });
    await enteredGate;
    const second = await b.runScheduled("health.probe-targets", {
      scheduledFor: T1,
      invocationId: "b",
    });
    expect(second).toMatchObject({ outcome: "skipped", reason: "live_lease" });
    release?.();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded" });
    expect(starts).toBe(1);
  });
});
