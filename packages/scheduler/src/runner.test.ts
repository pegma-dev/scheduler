import { fixedClock, type IsoTimestamp, type Logger } from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";
import { describe, expect, it } from "vitest";

import {
  createScheduler,
  defineScheduledTasks,
  type CreateSchedulerOptions,
  type ScheduledTaskHandler,
  type ScheduledTaskResult,
} from "./index.js";

const T0 = "2026-07-31T12:00:00.000Z" as IsoTimestamp;
const T1 = "2026-07-31T12:01:00.000Z" as IsoTimestamp;
const T2 = "2026-07-31T12:02:00.000Z" as IsoTimestamp;
const T3 = "2026-07-31T12:03:00.000Z" as IsoTimestamp;

type LogEntry = {
  readonly level: string;
  readonly message: string;
  readonly fields?: Readonly<Record<string, unknown>>;
};

function recordingLogger(): Logger & { readonly entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    log(level, message, fields) {
      entries.push({
        level,
        message,
        ...(fields === undefined ? {} : { fields }),
      });
    },
  };
}

function mutableClock(start: IsoTimestamp = T0): {
  readonly clock: { now(): IsoTimestamp };
  set(at: IsoTimestamp): void;
  advance(milliseconds: number): void;
} {
  let current = start;
  return {
    clock: {
      now() {
        return current;
      },
    },
    set(at) {
      current = at;
    },
    advance(milliseconds) {
      current = new Date(
        Date.parse(current) + milliseconds,
      ).toISOString() as IsoTimestamp;
    },
  };
}

function baseOptions(
  overrides: Partial<
    CreateSchedulerOptions<Record<string, ScheduledTaskHandler>>
  > & {
    readonly store?: Store;
    readonly tasks?: Record<string, ScheduledTaskHandler>;
  } = {},
): CreateSchedulerOptions<Record<string, ScheduledTaskHandler>> {
  const tasks =
    overrides.tasks ??
    defineScheduledTasks({
      "github.sync-orgs": async () => ({ nextCheckpoint: "page-2" }),
    });
  return {
    store: overrides.store ?? createMemoryStore(),
    clock: overrides.clock ?? fixedClock(T0),
    logger: overrides.logger ?? recordingLogger(),
    instanceId: overrides.instanceId ?? "ops-hub",
    workerId: overrides.workerId ?? "worker-a",
    tasks,
    leaseMilliseconds: overrides.leaseMilliseconds ?? 5_000,
    handlerTimeoutMilliseconds: overrides.handlerTimeoutMilliseconds ?? 4_000,
    ...(overrides.classifyFailure === undefined
      ? {}
      : { classifyFailure: overrides.classifyFailure }),
  };
}

describe("createScheduler", () => {
  it("claims an unseen task, advances a string checkpoint, and inspects state", async () => {
    const logger = recordingLogger();
    const store = createMemoryStore();
    const scheduler = createScheduler(
      baseOptions({
        store,
        logger,
        tasks: {
          "github.sync-orgs": async ({ checkpoint }) => {
            expect(checkpoint).toBeUndefined();
            return {
              nextCheckpoint: "page-2",
              more: true,
              summary: { pages: 1 },
            };
          },
        },
      }),
    );

    const result = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "inv-1",
    });

    expect(result.outcome).toBe("succeeded");
    if (result.outcome !== "succeeded") return;
    expect(result.state.checkpoint).toBe("page-2");
    expect(result.state.status).toBe("succeeded");
    expect(result.state.lastScheduledFor).toBe(T1);
    expect(result.state.leaseOwner).toBeUndefined();
    expect(result.result.summary).toEqual({ pages: 1 });

    await expect(scheduler.getState("github.sync-orgs")).resolves.toEqual(
      result.state,
    );
    expect(
      logger.entries.some(
        (entry) => entry.message === "scheduler.task.claimed",
      ),
    ).toBe(true);
    expect(
      logger.entries.some(
        (entry) => entry.message === "scheduler.task.succeeded",
      ),
    ).toBe(true);
  });

  it("lets two workers race an unseen task with one winner", async () => {
    const store = createMemoryStore();
    let releaseFirst: (() => void) | undefined;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let starts = 0;

    const handler: ScheduledTaskHandler = async () => {
      starts += 1;
      if (starts === 1) {
        await firstGate;
      }
      return { nextCheckpoint: `worker-${starts}` };
    };

    const a = createScheduler(
      baseOptions({
        store,
        workerId: "worker-a",
        tasks: { "github.sync-orgs": handler },
      }),
    );
    const b = createScheduler(
      baseOptions({
        store,
        workerId: "worker-b",
        tasks: { "github.sync-orgs": handler },
      }),
    );

    const first = a.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "a",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await b.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "b",
    });
    expect(second.outcome).toBe("skipped");
    if (second.outcome === "skipped") {
      expect(second.reason).toBe("live_lease");
    }
    releaseFirst?.();
    const winner = await first;
    expect(winner.outcome).toBe("succeeded");
    expect(starts).toBe(1);
  });

  it("lets two workers race an existing terminal task with one winner", async () => {
    const store = createMemoryStore();
    const seed = createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "page-1" }),
        },
      }),
    );
    await seed.runScheduled("github.sync-orgs", {
      scheduledFor: T0,
      invocationId: "seed",
    });

    let releaseFirst: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let starts = 0;
    const handler: ScheduledTaskHandler = async ({ checkpoint }) => {
      starts += 1;
      expect(checkpoint).toBe("page-1");
      if (starts === 1) await gate;
      return { nextCheckpoint: "page-2" };
    };

    const a = createScheduler(
      baseOptions({
        store,
        workerId: "worker-a",
        tasks: { "github.sync-orgs": handler },
      }),
    );
    const b = createScheduler(
      baseOptions({
        store,
        workerId: "worker-b",
        tasks: { "github.sync-orgs": handler },
      }),
    );

    const first = a.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "a",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = await b.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "b",
    });
    expect(second).toMatchObject({ outcome: "skipped", reason: "live_lease" });
    releaseFirst?.();
    await expect(first).resolves.toMatchObject({ outcome: "succeeded" });
    expect(starts).toBe(1);
  });

  it("skips a live lease and recovers an expired one", async () => {
    const time = mutableClock(T0);
    const store = createMemoryStore();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Lease expiry is judged by the injected clock. Keep the wall-clock
    // handler budget large enough that recovery can land first.
    const longRunner = createScheduler(
      baseOptions({
        store,
        clock: time.clock,
        workerId: "worker-a",
        leaseMilliseconds: 1_000,
        handlerTimeoutMilliseconds: 1_000,
        tasks: {
          "github.sync-orgs": async () => {
            await gate;
            return { nextCheckpoint: "stale-worker" };
          },
        },
      }),
    );

    const first = longRunner.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "slow",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    const liveSkip = await createScheduler(
      baseOptions({
        store,
        clock: time.clock,
        workerId: "worker-b",
        leaseMilliseconds: 1_000,
        handlerTimeoutMilliseconds: 1_000,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "too-early" }),
        },
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "live",
    });
    expect(liveSkip).toMatchObject({
      outcome: "skipped",
      reason: "live_lease",
    });

    time.advance(2_000);
    const recovered = await createScheduler(
      baseOptions({
        store,
        clock: time.clock,
        workerId: "worker-b",
        leaseMilliseconds: 5_000,
        handlerTimeoutMilliseconds: 4_000,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "recovered" }),
        },
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "recover",
    });
    expect(recovered.outcome).toBe("succeeded");
    if (recovered.outcome === "succeeded") {
      expect(recovered.state.checkpoint).toBe("recovered");
    }

    release?.();
    const stale = await first;
    expect(stale.outcome).toBe("stale_completion");
  });

  it("does not advance the checkpoint when the handler fails", async () => {
    const store = createMemoryStore();
    const scheduler = createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "page-1" }),
        },
      }),
    );
    await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T0,
      invocationId: "seed",
    });

    const failed = await createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => {
            throw new Error("provider exploded with secret token");
          },
        },
        classifyFailure: () => "provider_unavailable",
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "fail",
    });

    expect(failed.outcome).toBe("failed");
    if (failed.outcome !== "failed") return;
    expect(failed.failureCategory).toBe("provider_unavailable");
    expect(failed.state.checkpoint).toBe("page-1");
    expect(failed.state.consecutiveFailures).toBe(1);
    expect(failed.state.lastFailureCategory).toBe("provider_unavailable");
    expect(failed.state.leaseOwner).toBeUndefined();
  });

  it("retains, advances, and clears checkpoints according to the result", async () => {
    const store = createMemoryStore();
    const run = async (
      handler: () => Promise<ScheduledTaskResult>,
      scheduledFor: IsoTimestamp,
    ) => {
      const scheduler = createScheduler(
        baseOptions({
          store,
          tasks: { "github.sync-orgs": handler },
        }),
      );
      return scheduler.runScheduled("github.sync-orgs", {
        scheduledFor,
        invocationId: scheduledFor,
      });
    };

    await run(async () => ({ nextCheckpoint: "page-1" }), T0);
    const retained = await run(async () => ({ more: false }), T1);
    expect(retained.outcome).toBe("succeeded");
    if (retained.outcome === "succeeded") {
      expect(retained.state.checkpoint).toBe("page-1");
    }

    const advanced = await run(async () => ({ nextCheckpoint: "page-2" }), T2);
    expect(advanced.outcome).toBe("succeeded");
    if (advanced.outcome === "succeeded") {
      expect(advanced.state.checkpoint).toBe("page-2");
    }

    const closed = await run(async () => ({ nextCheckpoint: null }), T3);
    expect(closed.outcome).toBe("succeeded");
    if (closed.outcome === "succeeded") {
      expect(closed.state.checkpoint).toBeUndefined();
    }
  });

  it("suppresses older scheduled occurrences after a newer success", async () => {
    const store = createMemoryStore();
    const scheduler = createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "page-1" }),
        },
      }),
    );
    await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T2,
      invocationId: "new",
    });

    const stale = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "old",
    });
    expect(stale).toMatchObject({
      outcome: "skipped",
      reason: "stale_occurrence",
    });
  });

  it("lets manual runs bypass occurrence suppression while sharing the lease", async () => {
    const store = createMemoryStore();
    const seed = createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "page-1" }),
        },
      }),
    );
    await seed.runScheduled("github.sync-orgs", {
      scheduledFor: T2,
      invocationId: "seed",
    });

    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const busy = createScheduler(
      baseOptions({
        store,
        workerId: "worker-a",
        tasks: {
          "github.sync-orgs": async () => {
            await gate;
            return {};
          },
        },
      }),
    );
    const running = busy.runManual("github.sync-orgs", {
      invocationId: "manual-1",
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const blocked = await createScheduler(
      baseOptions({
        store,
        workerId: "worker-b",
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "nope" }),
        },
      }),
    ).runManual("github.sync-orgs", { invocationId: "manual-2" });
    expect(blocked).toMatchObject({ outcome: "skipped", reason: "live_lease" });

    release?.();
    await expect(running).resolves.toMatchObject({ outcome: "succeeded" });

    const forced = await createScheduler(
      baseOptions({
        store,
        clock: fixedClock(T0),
        tasks: {
          "github.sync-orgs": async ({ checkpoint }) => {
            expect(checkpoint).toBe("page-1");
            return { nextCheckpoint: "manual-page" };
          },
        },
      }),
    ).runManual("github.sync-orgs", { invocationId: "manual-3" });
    expect(forced.outcome).toBe("succeeded");
    if (forced.outcome === "succeeded") {
      expect(forced.state.checkpoint).toBe("manual-page");
      // Manual success must not rewrite monotonic scheduled occurrence state.
      expect(forced.state.lastScheduledFor).toBe(T2);
    }
  });

  it("times out a hung handler before the lease ends without clearing the lease", async () => {
    const logger = recordingLogger();
    const store = createMemoryStore();
    const scheduler = createScheduler(
      baseOptions({
        store,
        logger,
        workerId: "worker-a",
        leaseMilliseconds: 200,
        handlerTimeoutMilliseconds: 30,
        tasks: {
          "github.sync-orgs": async () => {
            await new Promise(() => {
              /* never settles */
            });
            return {};
          },
        },
      }),
    );

    const result = await scheduler.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "timeout",
    });
    expect(result.outcome).toBe("failed");
    if (result.outcome === "failed") {
      expect(result.failureCategory).toBe("handler_timeout");
      // The hung handler may still be running; keep the claim until expiry.
      expect(result.state.status).toBe("running");
      expect(result.state.leaseOwner).toBe("worker-a");
      expect(result.state.leaseExpiresAt).toBeDefined();
    }

    const blocked = await createScheduler(
      baseOptions({
        store,
        workerId: "worker-b",
        leaseMilliseconds: 200,
        handlerTimeoutMilliseconds: 30,
        tasks: {
          "github.sync-orgs": async () => ({ nextCheckpoint: "too-soon" }),
        },
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "blocked",
    });
    expect(blocked).toMatchObject({ outcome: "skipped", reason: "live_lease" });
  });

  it("rejects unsafe summaries and failure categories without persisting secrets", async () => {
    const store = createMemoryStore();
    const invalid = await createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () =>
            ({
              summary: { "bad key": 1 },
            }) as unknown as ScheduledTaskResult,
        },
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "bad-summary",
    });
    expect(invalid.outcome).toBe("failed");
    if (invalid.outcome === "failed") {
      expect(invalid.failureCategory).toBe("handler_result_invalid");
    }

    const secretFailure = await createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => {
            throw new Error("token=super-secret");
          },
        },
        classifyFailure: () => "token expired: secret",
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T2,
      invocationId: "bad-category",
    });
    expect(secretFailure.outcome).toBe("failed");
    if (secretFailure.outcome === "failed") {
      expect(secretFailure.failureCategory).toBe("handler_failed");
      expect(JSON.stringify(secretFailure.state)).not.toMatch(/super-secret/);
    }
  });

  it("rejects unregistered tasks and malformed options without invoking handlers", async () => {
    let calls = 0;
    const scheduler = createScheduler(
      baseOptions({
        tasks: {
          "github.sync-orgs": async () => {
            calls += 1;
            return {};
          },
        },
      }),
    );

    await expect(
      scheduler.runScheduled("mail.send" as "github.sync-orgs", {
        scheduledFor: T1,
        invocationId: "x",
      }),
    ).rejects.toThrow(/not registered/);
    expect(calls).toBe(0);

    expect(() =>
      createScheduler(
        baseOptions({
          leaseMilliseconds: 0,
        }),
      ),
    ).toThrow(/leaseMilliseconds/);
  });
});

describe("createScheduler crash semantics", () => {
  it("leaves no durable row when the process stops before the claim write finishes", async () => {
    // Crash before task call is modeled as never calling runScheduled after a
    // failed/incomplete claim attempt. An empty store stays empty.
    const store = createMemoryStore();
    const scheduler = createScheduler(
      baseOptions({
        store,
        tasks: {
          "github.sync-orgs": async () => ({
            nextCheckpoint: "should-not-run",
          }),
        },
      }),
    );
    await expect(scheduler.getState("github.sync-orgs")).resolves.toBeNull();
  });

  it("re-runs work after a crash between side effect and fenced completion", async () => {
    const store = createMemoryStore();
    const effects: string[] = [];
    let release: ((value: ScheduledTaskResult) => void) | undefined;
    const hang = new Promise<ScheduledTaskResult>((resolve) => {
      release = resolve;
    });

    const time = mutableClock(T0);
    const first = createScheduler(
      baseOptions({
        store,
        clock: time.clock,
        workerId: "worker-a",
        leaseMilliseconds: 1_000,
        handlerTimeoutMilliseconds: 1_000,
        tasks: {
          "github.sync-orgs": async () => {
            effects.push("side-effect");
            return hang;
          },
        },
      }),
    );

    const running = first.runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "crashy",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(effects).toEqual(["side-effect"]);

    // Simulate lease expiry + recovery without waiting for the first handler.
    time.advance(2_000);
    const recovered = await createScheduler(
      baseOptions({
        store,
        clock: time.clock,
        workerId: "worker-b",
        leaseMilliseconds: 5_000,
        handlerTimeoutMilliseconds: 4_000,
        tasks: {
          "github.sync-orgs": async () => {
            effects.push("side-effect-again");
            return { nextCheckpoint: "after-crash" };
          },
        },
      }),
    ).runScheduled("github.sync-orgs", {
      scheduledFor: T1,
      invocationId: "recover",
    });
    expect(recovered.outcome).toBe("succeeded");
    expect(effects).toEqual(["side-effect", "side-effect-again"]);

    release?.({ nextCheckpoint: "from-stale-worker" });
    await expect(running).resolves.toMatchObject({
      outcome: "stale_completion",
    });

    const state = await createScheduler(
      baseOptions({ store, tasks: { "github.sync-orgs": async () => ({}) } }),
    ).getState("github.sync-orgs");
    expect(state?.checkpoint).toBe("after-crash");
  });
});
