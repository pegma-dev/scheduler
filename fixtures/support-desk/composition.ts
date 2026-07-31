/**
 * Support Desk–shaped consumer fixture.
 *
 * Mirrors host loops from support-desk docs/HOST_COMPOSITION.md:
 * mail.send, mail.reconcile, mail.terminal-sweep, queue.repair,
 * queue.inactive-sweep. Receipt/principal sweeps stay host-selected drivers
 * outside Scheduler (no dynamic per-bucket tasks).
 *
 * Domain page functions are fakes with the same cursor/checkpoint contract
 * real Support Desk entry points expose.
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

export interface BoundedPage {
  readonly examined: number;
  readonly nextCursor: string | null;
}

export interface SupportDeskDomain {
  runSendPage(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<BoundedPage & { readonly accepted: number }>;
  runReconciliationPage(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<BoundedPage>;
  runTerminalSweep(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly deleted: number; readonly nextCursor: string | null }>;
  repairQueueProjectionPage(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<BoundedPage>;
  sweepInactiveQueueProjections(input: {
    readonly limit: number;
    readonly cursor?: string;
  }): Promise<{ readonly deleted: number; readonly nextCursor: string | null }>;
}

type SupportTasks = {
  "mail.send": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "mail.reconcile": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "mail.terminal-sweep": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "queue.repair": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
  "queue.inactive-sweep": (
    context: import("@pegma/scheduler").ScheduledTaskContext,
  ) => Promise<import("@pegma/scheduler").ScheduledTaskResult>;
};

export interface SupportDeskComposition {
  readonly store: Store;
  readonly scheduler: Scheduler<SupportTasks>;
  readonly domain: SupportDeskDomain;
  runScheduled(
    taskId: keyof SupportTasks & string,
    scheduledFor: IsoTimestamp,
  ): Promise<SchedulerRunResult>;
}

function pageFromCursor(
  cursor: string | undefined,
  firstToken: string,
): BoundedPage {
  if (cursor === undefined) {
    return { examined: 2, nextCursor: firstToken };
  }
  return { examined: 1, nextCursor: null };
}

export function createFakeSupportDeskDomain(): SupportDeskDomain & {
  readonly calls: Readonly<Record<string, number>>;
} {
  const calls: Record<string, number> = Object.create(null) as Record<
    string,
    number
  >;
  const bump = (name: string) => {
    calls[name] = (calls[name] ?? 0) + 1;
  };
  return {
    get calls() {
      return calls;
    },
    async runSendPage({ cursor }) {
      bump("mail.send");
      const page = pageFromCursor(cursor, "send:1");
      return { ...page, accepted: page.examined };
    },
    async runReconciliationPage({ cursor }) {
      bump("mail.reconcile");
      return pageFromCursor(cursor, "reconcile:1");
    },
    async runTerminalSweep({ cursor }) {
      bump("mail.terminal-sweep");
      const page = pageFromCursor(cursor, "terminal:1");
      return { deleted: page.examined, nextCursor: page.nextCursor };
    },
    async repairQueueProjectionPage({ cursor }) {
      bump("queue.repair");
      return pageFromCursor(cursor, "repair:1");
    },
    async sweepInactiveQueueProjections({ cursor }) {
      bump("queue.inactive-sweep");
      const page = pageFromCursor(cursor, "inactive:1");
      return { deleted: page.examined, nextCursor: page.nextCursor };
    },
  };
}

export function createSupportDeskComposition(options?: {
  readonly store?: Store;
  readonly clock?: Clock;
  readonly workerId?: string;
  readonly domain?: SupportDeskDomain;
}): SupportDeskComposition {
  const store = options?.store ?? createMemoryStore();
  const clock = options?.clock ?? fixedClock("2026-07-31T12:00:00.000Z");
  const domain = options?.domain ?? createFakeSupportDeskDomain();

  const tasks = defineScheduledTasks({
    "mail.send": async ({ checkpoint }) => {
      const page = await domain.runSendPage({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { accepted: page.accepted, examined: page.examined },
        more: page.nextCursor !== null,
      };
    },
    "mail.reconcile": async ({ checkpoint }) => {
      const page = await domain.runReconciliationPage({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { examined: page.examined },
        more: page.nextCursor !== null,
      };
    },
    "mail.terminal-sweep": async ({ checkpoint }) => {
      const page = await domain.runTerminalSweep({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { deleted: page.deleted },
        more: page.nextCursor !== null,
      };
    },
    "queue.repair": async ({ checkpoint }) => {
      const page = await domain.repairQueueProjectionPage({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { examined: page.examined },
        more: page.nextCursor !== null,
      };
    },
    "queue.inactive-sweep": async ({ checkpoint }) => {
      const page = await domain.sweepInactiveQueueProjections({
        limit: 50,
        ...(checkpoint === undefined ? {} : { cursor: checkpoint }),
      });
      return {
        nextCheckpoint: page.nextCursor,
        summary: { deleted: page.deleted },
        more: page.nextCursor !== null,
      };
    },
  });

  const scheduler = createScheduler({
    store,
    clock,
    logger: noopLogger,
    instanceId: "retiregolden-support",
    workerId: options?.workerId ?? "support-worker",
    tasks,
    leaseMilliseconds: 30_000,
    handlerTimeoutMilliseconds: 25_000,
  });

  return {
    store,
    scheduler,
    domain,
    runScheduled(taskId, scheduledFor) {
      return scheduler.runScheduled(taskId, {
        scheduledFor,
        invocationId: `${taskId}:${scheduledFor}`,
      });
    },
  };
}
