import { describe, expect, it } from "vitest";

import {
  defineScheduledTasks,
  schedulerTaskStateKey,
  schedulerTaskStates,
  type SchedulerTaskState,
} from "./index.js";

const timestamp = "2026-07-31T12:00:00.000Z" as const;

function succeededState(
  overrides: Partial<SchedulerTaskState> = {},
): SchedulerTaskState {
  return {
    schemaVersion: 1,
    instanceId: "ops-hub",
    taskId: "github.sync-orgs",
    status: "succeeded",
    checkpoint: "page-2",
    consecutiveFailures: 0,
    lastScheduledFor: timestamp,
    lastStartedAt: timestamp,
    lastCompletedAt: timestamp,
    ...overrides,
  };
}

describe("defineScheduledTasks", () => {
  it("preserves explicit literal task names and freezes a safe copy", async () => {
    const original = {
      "health.probe-targets": async () => ({ more: false }),
      "github.sync-orgs": async () => ({ nextCheckpoint: "page-2" }),
    };
    const tasks = defineScheduledTasks(original);

    expect(Object.isFrozen(tasks)).toBe(true);
    expect(Object.getPrototypeOf(tasks)).toBeNull();
    expect(Object.keys(tasks)).toEqual([
      "health.probe-targets",
      "github.sync-orgs",
    ]);
    expect(
      await tasks["github.sync-orgs"]?.({
        scheduledFor: timestamp,
        invocationId: "invocation-1",
      }),
    ).toEqual({ nextCheckpoint: "page-2" });
  });

  it.each(["", "Mail.Send", "mail send", "mail/send", "_mail"])(
    "rejects dynamic or non-canonical task id %j",
    (taskId) => {
      expect(() =>
        defineScheduledTasks({ [taskId]: async () => ({}) }),
      ).toThrow(/taskId must be a lowercase static identifier/);
    },
  );

  it("rejects an accessor without invoking it", () => {
    let reads = 0;
    const tasks = Object.defineProperty({}, "mail.send", {
      enumerable: true,
      get() {
        reads += 1;
        return async () => ({});
      },
    }) as Record<string, () => Promise<never>>;

    expect(() => defineScheduledTasks(tasks)).toThrow(/own data property/);
    expect(reads).toBe(0);
  });
});

describe("scheduler task state", () => {
  it("uses one isolated partition per host instance", () => {
    expect(schedulerTaskStateKey("retiregolden-support", "mail.send")).toEqual({
      partition: "retiregolden-support",
      id: "mail.send",
    });
  });

  it("round-trips terminal state through the flat storage codec", () => {
    const state = succeededState();
    const encoded = schedulerTaskStates.codec.encode(state);
    expect(schedulerTaskStates.codec.decode(encoded)).toEqual(state);
  });

  it("round-trips a complete running lease", () => {
    const state: SchedulerTaskState = {
      schemaVersion: 1,
      instanceId: "pegma-support",
      taskId: "mail.send",
      status: "running",
      consecutiveFailures: 1,
      lastStartedAt: timestamp,
      leaseOwner: "worker-1",
      claimToken: "claim-1",
      leaseExpiresAt: "2026-07-31T12:01:00.000Z",
    };
    expect(
      schedulerTaskStates.codec.decode(schedulerTaskStates.codec.encode(state)),
    ).toEqual(state);
  });

  it("rejects incomplete and leaked leases", () => {
    expect(() =>
      schedulerTaskStates.codec.encode(
        succeededState({ leaseOwner: "stale-worker" }),
      ),
    ).toThrow(/terminal state forbids lease fields/);

    expect(() =>
      schedulerTaskStates.codec.encode({
        schemaVersion: 1,
        instanceId: "ops-hub",
        taskId: "github.sync-orgs",
        status: "running",
        consecutiveFailures: 0,
        lastStartedAt: timestamp,
        leaseOwner: "worker-1",
      }),
    ).toThrow(/running state requires a complete lease/);
  });

  it("rejects unsafe checkpoints and failure detail", () => {
    expect(() =>
      schedulerTaskStates.codec.encode(
        succeededState({ checkpoint: "page\u000a2" }),
      ),
    ).toThrow(/checkpoint must be/);
    expect(() =>
      schedulerTaskStates.codec.encode(
        succeededState({
          status: "failed",
          consecutiveFailures: 1,
          lastFailureCategory: "token expired: secret",
        }),
      ),
    ).toThrow(/coarse safe token/);
  });

  it("treats omitted optional fields as absent for backends that drop nulls", () => {
    const encoded = schedulerTaskStates.codec.encode(succeededState());
    const withoutNulls = Object.fromEntries(
      Object.entries(encoded).filter(([, value]) => value !== null),
    );
    expect(schedulerTaskStates.codec.decode(withoutNulls)).toEqual(
      succeededState(),
    );
  });
});
