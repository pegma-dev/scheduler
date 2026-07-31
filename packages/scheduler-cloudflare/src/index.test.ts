import {
  createScheduler,
  defineScheduledTasks,
  type SchedulerRunResult,
} from "@pegma/scheduler";
import { fixedClock, type IsoTimestamp, type Logger } from "@pegma/spine";
import { createMemoryStore } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  createCloudflareSchedulerDispatch,
  type CloudflareExecutionContext,
  type CloudflareScheduledController,
} from "./index.js";

const T0_MS = Date.parse("2026-07-31T12:00:00.000Z");
const T1_MS = Date.parse("2026-07-31T12:01:00.000Z");
const T0 = "2026-07-31T12:00:00.000Z" as IsoTimestamp;

function recordingLogger(): Logger & {
  readonly entries: { readonly message: string }[];
} {
  const entries: { readonly message: string }[] = [];
  return {
    entries,
    log(_level, message) {
      entries.push({ message });
    },
  };
}

function controller(
  overrides: Partial<CloudflareScheduledController> = {},
): CloudflareScheduledController {
  return {
    scheduledTime: T1_MS,
    cron: "* * * * *",
    ...overrides,
  };
}

function recordingContext(): CloudflareExecutionContext & {
  readonly waited: Promise<unknown>[];
} {
  const waited: Promise<unknown>[] = [];
  return {
    waited,
    waitUntil(promise) {
      waited.push(promise);
    },
  };
}

function makeScheduler(
  handlers: Parameters<typeof defineScheduledTasks>[0],
  options: {
    readonly store?: ReturnType<typeof createMemoryStore>;
    readonly workerId?: string;
  } = {},
) {
  const store = options.store ?? createMemoryStore();
  const tasks = defineScheduledTasks(handlers);
  const scheduler = createScheduler({
    store,
    clock: fixedClock(T0),
    logger: recordingLogger(),
    instanceId: "ops-hub",
    workerId: options.workerId ?? "worker-cf",
    tasks,
    leaseMilliseconds: 5_000,
    handlerTimeoutMilliseconds: 4_000,
  });
  return { store, scheduler, tasks };
}

describe("createCloudflareSchedulerDispatch", () => {
  it("routes cron to registered tasks using scheduledTime and waitUntil", async () => {
    const seen: { readonly scheduledFor: string; readonly id: string }[] = [];
    const { scheduler } = makeScheduler({
      "health.probe-targets": async (context) => {
        seen.push({
          scheduledFor: context.scheduledFor,
          id: context.invocationId,
        });
        return { more: false };
      },
    });
    let invocation = 0;
    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: {
        "* * * * *": ["health.probe-targets"],
      },
      newInvocationId: () => `inv-${++invocation}`,
    });
    const ctx = recordingContext();
    const results = await dispatch.scheduled(controller(), ctx);

    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("succeeded");
    expect(seen).toEqual([
      { scheduledFor: "2026-07-31T12:01:00.000Z", id: "inv-1" },
    ]);
    expect(ctx.waited).toHaveLength(1);
    await expect(ctx.waited[0]).resolves.toEqual(results);
  });

  it("runs every task mapped to the same cron expression in order", async () => {
    const order: string[] = [];
    const { scheduler } = makeScheduler({
      "health.probe-targets": async () => {
        order.push("health");
        return {};
      },
      "github.sync-orgs": async () => {
        order.push("github");
        return { nextCheckpoint: "page-1" };
      },
    });
    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: {
        "*/5 * * * *": ["health.probe-targets", "github.sync-orgs"],
      },
      newInvocationId: () => "shared",
    });

    const results = await dispatch.scheduled(
      controller({ cron: "*/5 * * * *" }),
    );
    expect(order).toEqual(["health", "github"]);
    expect(results.map((result) => result.outcome)).toEqual([
      "succeeded",
      "succeeded",
    ]);
  });

  it("fails closed for an unmapped cron expression", async () => {
    const { scheduler } = makeScheduler({
      "health.probe-targets": async () => ({}),
    });
    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: { "* * * * *": ["health.probe-targets"] },
    });

    await expect(
      dispatch.scheduled(controller({ cron: "0 * * * *" })),
    ).rejects.toThrow(/no scheduled tasks are routed/);
  });

  it("rejects malformed routes and controllers without invoking tasks", async () => {
    const { scheduler } = makeScheduler({
      "health.probe-targets": async () => {
        throw new Error("should not run");
      },
    });

    expect(() =>
      createCloudflareSchedulerDispatch({
        scheduler,
        routes: {},
      }),
    ).toThrow(/at least one cron route/);

    expect(() =>
      createCloudflareSchedulerDispatch({
        scheduler,
        routes: {
          "* * * * *": [],
        },
      }),
    ).toThrow(/non-empty array/);

    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: { "* * * * *": ["health.probe-targets"] },
    });
    await expect(
      dispatch.scheduled({
        cron: "* * * * *",
        scheduledTime: Number.NaN,
      }),
    ).rejects.toThrow(/scheduledTime/);
  });

  it("suppresses overlap when the same task is already running", async () => {
    const store = createMemoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const enteredGate = new Promise<void>((resolve) => {
      entered = resolve;
    });

    const first = makeScheduler(
      {
        "health.probe-targets": async () => {
          entered?.();
          await gate;
          return {};
        },
      },
      { store, workerId: "worker-a" },
    );
    const second = makeScheduler(
      {
        "health.probe-targets": async () => ({ nextCheckpoint: "nope" }),
      },
      { store, workerId: "worker-b" },
    );

    const dispatchA = createCloudflareSchedulerDispatch({
      scheduler: first.scheduler,
      routes: { "* * * * *": ["health.probe-targets"] },
      newInvocationId: () => "a",
    });
    const dispatchB = createCloudflareSchedulerDispatch({
      scheduler: second.scheduler,
      routes: { "* * * * *": ["health.probe-targets"] },
      newInvocationId: () => "b",
    });

    const running = dispatchA.scheduled(controller({ scheduledTime: T1_MS }));
    await enteredGate;
    const overlap = await dispatchB.scheduled(
      controller({ scheduledTime: T1_MS }),
    );
    expect(overlap[0]).toMatchObject({
      outcome: "skipped",
      reason: "live_lease",
    });
    release?.();
    const completed = await running;
    expect(completed[0]?.outcome).toBe("succeeded");
  });

  it("advances checkpoints across successive scheduled occurrences", async () => {
    const store = createMemoryStore();
    const { scheduler } = makeScheduler(
      {
        "github.sync-orgs": async ({ checkpoint }) => {
          if (checkpoint === undefined) return { nextCheckpoint: "page-1" };
          if (checkpoint === "page-1") return { nextCheckpoint: null };
          return {};
        },
      },
      { store },
    );
    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: { "*/10 * * * *": ["github.sync-orgs"] },
      newInvocationId: () => "cycle",
    });

    const first = await dispatch.scheduled(
      controller({ cron: "*/10 * * * *", scheduledTime: T0_MS }),
    );
    expect(first[0]).toMatchObject({ outcome: "succeeded" });
    if (first[0]?.outcome === "succeeded") {
      expect(first[0].state.checkpoint).toBe("page-1");
    }

    const second = await dispatch.scheduled(
      controller({ cron: "*/10 * * * *", scheduledTime: T1_MS }),
    );
    expect(second[0]).toMatchObject({ outcome: "succeeded" });
    if (second[0]?.outcome === "succeeded") {
      expect(second[0].state.checkpoint).toBeUndefined();
      expect(second[0].state.lastScheduledFor).toBe("2026-07-31T12:01:00.000Z");
    }

    const stale = await dispatch.scheduled(
      controller({ cron: "*/10 * * * *", scheduledTime: T0_MS }),
    );
    expect(stale[0]).toMatchObject({
      outcome: "skipped",
      reason: "stale_occurrence",
    });
  });
});

describe("CloudflareSchedulerDispatch result typing", () => {
  it("returns a frozen result list", async () => {
    const { scheduler } = makeScheduler({
      "health.probe-targets": async () => ({}),
    });
    const dispatch = createCloudflareSchedulerDispatch({
      scheduler,
      routes: { "* * * * *": ["health.probe-targets"] },
    });
    const results: readonly SchedulerRunResult[] =
      await dispatch.scheduled(controller());
    expect(Object.isFrozen(results)).toBe(true);
  });
});
