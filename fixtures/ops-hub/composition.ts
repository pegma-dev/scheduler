/**
 * Ops Hub–shaped consumer fixture.
 *
 * Mirrors the planned composition-root tasks from ops-hub docs:
 * - health.probe-targets (~30s local cadence via Docker → /__scheduled)
 * - github.sync-orgs (5–15 min cron)
 *
 * Domain probe/sync logic stays in Ops Hub. This fixture only proves the
 * durable coordination boundary with exact workspace package pins.
 */
import {
  createScheduler,
  defineScheduledTasks,
  type Scheduler,
  type SchedulerRunResult,
} from "@pegma/scheduler";
import { createCloudflareSchedulerDispatch } from "@pegma/scheduler-cloudflare";
import {
  fixedClock,
  noopLogger,
  type Clock,
  type IsoTimestamp,
} from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";

export interface HealthProbePage {
  readonly probed: number;
  readonly nextCursor: string | null;
}

export interface GitHubSyncPage {
  readonly orgsSynced: number;
  readonly nextCursor: string | null;
}

export interface OpsHubDomain {
  probeTargets(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<HealthProbePage>;
  syncOrgs(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<GitHubSyncPage>;
}

export type OpsHubTasks = {
  "health.probe-targets": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "github.sync-orgs": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
};

export interface OpsHubComposition {
  readonly store: Store;
  readonly scheduler: Scheduler<OpsHubTasks>;
  readonly dispatch: ReturnType<
    typeof createCloudflareSchedulerDispatch<OpsHubTasks>
  >;
  readonly domain: OpsHubDomain;
}

export function createFakeOpsHubDomain(): OpsHubDomain & {
  readonly probeCalls: number;
  readonly syncCalls: number;
} {
  let probeCalls = 0;
  let syncCalls = 0;
  return {
    get probeCalls() {
      return probeCalls;
    },
    get syncCalls() {
      return syncCalls;
    },
    async probeTargets({ limit, cursor }) {
      probeCalls += 1;
      if (cursor === undefined) {
        return { probed: Math.min(limit, 2), nextCursor: "targets:2" };
      }
      return { probed: 1, nextCursor: null };
    },
    async syncOrgs({ limit, cursor }) {
      syncCalls += 1;
      if (cursor === undefined) {
        return { orgsSynced: Math.min(limit, 1), nextCursor: "orgs:1" };
      }
      return { orgsSynced: 1, nextCursor: null };
    },
  };
}

export function createOpsHubComposition(options?: {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly workerId?: string;
  readonly domain?: OpsHubDomain;
}): OpsHubComposition {
  const store = options?.store ?? createMemoryStore();
  const clock = options?.clock ?? fixedClock("2026-07-31T12:00:00.000Z");
  const domain = options?.domain ?? createFakeOpsHubDomain();

  const tasks = defineScheduledTasks({
    "health.probe-targets": async ({ checkpoint }) => {
      const page = await domain.probeTargets({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { probed: page.probed },
        more: page.nextCursor !== null,
      };
    },
    "github.sync-orgs": async ({ checkpoint }) => {
      const page = await domain.syncOrgs({
        limit: 10,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { orgs: page.orgsSynced },
        more: page.nextCursor !== null,
      };
    },
  });

  const scheduler = createScheduler({
    store,
    clock,
    logger: noopLogger,
    instanceId: "ops-hub",
    workerId: options?.workerId ?? "ops-hub-worker",
    tasks,
    leaseMilliseconds: 30_000,
    handlerTimeoutMilliseconds: 25_000,
  });

  const dispatch = createCloudflareSchedulerDispatch({
    scheduler,
    routes: {
      // Local Docker 30s driver hits /__scheduled with this expression.
      "* * * * *": ["health.probe-targets"],
      "*/10 * * * *": ["github.sync-orgs"],
    },
  });

  return { store, scheduler, dispatch, domain };
}

export async function runOpsHubHealthOccurrence(
  composition: OpsHubComposition,
  scheduledFor: IsoTimestamp,
): Promise<SchedulerRunResult> {
  const [result] = await composition.dispatch.scheduled({
    cron: "* * * * *",
    scheduledTime: Date.parse(scheduledFor),
  });
  if (result === undefined) {
    throw new Error("health route produced no result");
  }
  return result;
}

export async function runOpsHubGitHubOccurrence(
  composition: OpsHubComposition,
  scheduledFor: IsoTimestamp,
): Promise<SchedulerRunResult> {
  const [result] = await composition.dispatch.scheduled({
    cron: "*/10 * * * *",
    scheduledTime: Date.parse(scheduledFor),
  });
  if (result === undefined) {
    throw new Error("github route produced no result");
  }
  return result;
}
