import { env } from "cloudflare:workers";
import {
  createScheduler,
  defineScheduledTasks,
  type Scheduler,
} from "@pegma/scheduler";
import { fixedClock, noopLogger, type IsoTimestamp } from "@pegma/spine";
import { createCloudflareD1Store } from "@pegma/storage-cloudflare-d1";
import { schedulerTaskStates } from "@pegma/scheduler";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";

import { createCloudflareSchedulerDispatch } from "./index.js";

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
    }
  }
}

const T0 = "2026-07-31T12:00:00.000Z" as IsoTimestamp;
const T0_MS = Date.parse(T0);
const T1_MS = Date.parse("2026-07-31T12:01:00.000Z");
const T2_MS = Date.parse("2026-07-31T12:02:00.000Z");

function compose(workerId: string): {
  readonly scheduler: Scheduler<{
    "github.sync-orgs": (
      context: import("@pegma/scheduler").ScheduledTaskContext,
    ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  }>;
  readonly dispatch: ReturnType<
    typeof createCloudflareSchedulerDispatch<{
      "github.sync-orgs": (
        context: import("@pegma/scheduler").ScheduledTaskContext,
      ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
    }>
  >;
} {
  const store = createCloudflareD1Store({ database: env.DB });
  const tasks = defineScheduledTasks({
    "github.sync-orgs": async ({ checkpoint }) => {
      if (checkpoint === undefined) {
        return { nextCheckpoint: "page-1", summary: { pages: 1 } };
      }
      if (checkpoint === "page-1") {
        return { nextCheckpoint: null, summary: { pages: 1 } };
      }
      return {};
    },
  });
  const scheduler = createScheduler({
    store,
    clock: fixedClock(T0),
    logger: noopLogger,
    instanceId: "ops-hub-d1",
    workerId,
    tasks,
    leaseMilliseconds: 10_000,
    handlerTimeoutMilliseconds: 8_000,
  });
  const dispatch = createCloudflareSchedulerDispatch({
    scheduler,
    routes: {
      "*/10 * * * *": ["github.sync-orgs"],
    },
    newInvocationId: () => `d1-${workerId}-${Date.now()}`,
  });
  return { scheduler, dispatch };
}

beforeAll(async () => {
  // Create schema via the adapter before clearing tables between tests.
  const store = createCloudflareD1Store({ database: env.DB });
  await store
    .collection(schedulerTaskStates)
    .get({ partition: "ops-hub-d1", id: "github.sync-orgs" });
});

beforeEach(async () => {
  // Pool isolates storage per file, not per test.
  await env.DB.prepare("DELETE FROM RECORDS").run();
  await env.DB.prepare("DELETE FROM PEGMA_STORAGE_D1_TX_GUARD").run();
});

describe("scheduler-cloudflare against real local D1", () => {
  it("completes a checkpoint cycle with occurrence suppression", async () => {
    const { dispatch, scheduler } = compose("worker-a");

    const first = await dispatch.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T0_MS,
    });
    expect(first[0]?.outcome).toBe("succeeded");
    await expect(scheduler.getState("github.sync-orgs")).resolves.toMatchObject(
      {
        status: "succeeded",
        checkpoint: "page-1",
      },
    );

    const second = await dispatch.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T1_MS,
    });
    expect(second[0]?.outcome).toBe("succeeded");
    if (second[0]?.outcome === "succeeded") {
      expect(second[0].state.checkpoint).toBeUndefined();
      expect(second[0].state.lastScheduledFor).toBe("2026-07-31T12:01:00.000Z");
    }

    const stale = await dispatch.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T0_MS,
    });
    expect(stale[0]).toMatchObject({
      outcome: "skipped",
      reason: "stale_occurrence",
    });
  });

  it("survives isolate restart with durable D1 state", async () => {
    const firstIsolate = compose("worker-a");
    const first = await firstIsolate.dispatch.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T0_MS,
    });
    expect(first[0]?.outcome).toBe("succeeded");

    // A new composition over the same D1 binding models a Worker restart.
    const restarted = compose("worker-b");
    await expect(
      restarted.scheduler.getState("github.sync-orgs"),
    ).resolves.toMatchObject({
      status: "succeeded",
      checkpoint: "page-1",
    });

    const next = await restarted.dispatch.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T2_MS,
    });
    expect(next[0]?.outcome).toBe("succeeded");
    if (next[0]?.outcome === "succeeded") {
      expect(next[0].state.checkpoint).toBeUndefined();
      expect(next[0].state.lastScheduledFor).toBe("2026-07-31T12:02:00.000Z");
    }
  });

  it("fences overlapping scheduled deliveries on the same task", async () => {
    const store = createCloudflareD1Store({ database: env.DB });
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
      "github.sync-orgs": async () => {
        starts += 1;
        if (starts === 1) {
          entered?.();
          await gate;
        }
        return { nextCheckpoint: "overlap" };
      },
    });

    const a = createScheduler({
      store,
      clock: fixedClock(T0),
      logger: noopLogger,
      instanceId: "ops-hub-d1",
      workerId: "worker-a",
      tasks,
      leaseMilliseconds: 10_000,
      handlerTimeoutMilliseconds: 8_000,
    });
    const b = createScheduler({
      store,
      clock: fixedClock(T0),
      logger: noopLogger,
      instanceId: "ops-hub-d1",
      workerId: "worker-b",
      tasks,
      leaseMilliseconds: 10_000,
      handlerTimeoutMilliseconds: 8_000,
    });

    const dispatchA = createCloudflareSchedulerDispatch({
      scheduler: a,
      routes: { "*/10 * * * *": ["github.sync-orgs"] },
      newInvocationId: () => "a",
    });
    const dispatchB = createCloudflareSchedulerDispatch({
      scheduler: b,
      routes: { "*/10 * * * *": ["github.sync-orgs"] },
      newInvocationId: () => "b",
    });

    const running = dispatchA.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T1_MS,
    });
    await enteredGate;
    const overlap = await dispatchB.scheduled({
      cron: "*/10 * * * *",
      scheduledTime: T1_MS,
    });
    expect(overlap[0]).toMatchObject({
      outcome: "skipped",
      reason: "live_lease",
    });
    release?.();
    await expect(running).resolves.toMatchObject([{ outcome: "succeeded" }]);
    expect(starts).toBe(1);
  });

  it("registers work with waitUntil on the execution context", async () => {
    const { dispatch } = compose("worker-wait");
    const waited: Promise<unknown>[] = [];
    const results = await dispatch.scheduled(
      {
        cron: "*/10 * * * *",
        scheduledTime: T0_MS,
      },
      {
        waitUntil(promise) {
          waited.push(promise);
        },
      },
    );
    expect(waited).toHaveLength(1);
    await expect(waited[0]).resolves.toEqual(results);
    expect(results[0]?.outcome).toBe("succeeded");
  });
});
