/**
 * RetireGolden-shaped Azure Functions timer composition fixture.
 *
 * Azure owns the timer trigger wakeup. This fixture shows how a host would
 * call createScheduler.runScheduled from a timer function without a dedicated
 * Azure adapter package (none is justified until a second Azure consumer
 * appears — see docs/ARCHITECTURE.md).
 */
import {
  createScheduler,
  defineScheduledTasks,
  type Scheduler,
  type SchedulerRunResult,
} from "@pegma/scheduler";
import {
  fixedClock,
  noopLogger,
  type Clock,
  type IsoTimestamp,
} from "@pegma/spine";
import { createMemoryStore, type Store } from "@pegma/storage-core";

export interface AzureTimerDomain {
  refreshProjection(input: {
    readonly cursor?: string;
  }): Promise<{ readonly nextCursor: string | null; readonly rows: number }>;
}

export interface AzureTimerComposition {
  readonly store: Store;
  readonly scheduler: Scheduler<{
    "retiregolden.projection.refresh": (
      context: import("@pegma/scheduler").ScheduledTaskContext,
    ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  }>;
  /**
   * Host timer entry point. `scheduledFor` is the trusted occurrence time the
   * Azure Functions host supplies (not provider time).
   */
  onTimer(scheduledFor: IsoTimestamp): Promise<SchedulerRunResult>;
}

export function createFakeAzureDomain(): AzureTimerDomain & {
  readonly refreshes: number;
} {
  let refreshes = 0;
  return {
    get refreshes() {
      return refreshes;
    },
    async refreshProjection({ cursor }) {
      refreshes += 1;
      if (cursor === undefined) {
        return { rows: 25, nextCursor: "proj:25" };
      }
      return { rows: 10, nextCursor: null };
    },
  };
}

export function createAzureFunctionsComposition(options?: {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly workerId?: string;
  readonly domain?: AzureTimerDomain;
}): AzureTimerComposition {
  const store = options?.store ?? createMemoryStore();
  const clock = options?.clock ?? fixedClock("2026-07-31T12:00:00.000Z");
  const domain = options?.domain ?? createFakeAzureDomain();

  const tasks = defineScheduledTasks({
    "retiregolden.projection.refresh": async ({ checkpoint }) => {
      const page = await domain.refreshProjection({
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { rows: page.rows },
        more: page.nextCursor !== null,
      };
    },
  });

  const scheduler = createScheduler({
    store,
    clock,
    logger: noopLogger,
    instanceId: "retiregolden-azure",
    workerId: options?.workerId ?? "azure-func-instance",
    tasks,
    leaseMilliseconds: 60_000,
    handlerTimeoutMilliseconds: 55_000,
  });

  return {
    store,
    scheduler,
    onTimer(scheduledFor) {
      return scheduler.runScheduled("retiregolden.projection.refresh", {
        scheduledFor,
        invocationId: `timer:${scheduledFor}`,
      });
    },
  };
}
