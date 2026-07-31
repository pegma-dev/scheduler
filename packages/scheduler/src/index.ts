import type { IsoTimestamp } from "@pegma/spine";
import {
  defineCollection,
  type CollectionDefinition,
  type EntityKey,
  type StoredRecord,
} from "@pegma/storage-core";

export type SchedulerTaskStatus = "running" | "succeeded" | "failed";

export interface ScheduledTaskContext {
  /** Opaque value returned by this task's last successful invocation. */
  readonly checkpoint?: string;
  /** Trusted host time for the scheduled occurrence, not provider time. */
  readonly scheduledFor: IsoTimestamp;
  /** Host-issued identifier for diagnostics and execution correlation. */
  readonly invocationId: string;
}

export interface ScheduledTaskResult {
  /** A string advances a cycle; null closes it; omission leaves it unchanged. */
  readonly nextCheckpoint?: string | null;
  /** Safe operational hint only. The scheduler does not auto-loop in v0.1. */
  readonly more?: boolean;
  /** Bounded, content-free counters suitable for logs and run inspection. */
  readonly summary?: Readonly<Record<string, number>>;
}

export type ScheduledTaskHandler = (
  context: ScheduledTaskContext,
) => Promise<ScheduledTaskResult>;

export type ScheduledTaskDefinitions = Readonly<
  Record<string, ScheduledTaskHandler>
>;

export type DefinedScheduledTasks<TTasks extends ScheduledTaskDefinitions> =
  Readonly<{ [TTaskId in keyof TTasks]: ScheduledTaskHandler }>;

/** Durable state for one statically registered task in one host instance. */
export interface SchedulerTaskState {
  readonly schemaVersion: 1;
  readonly instanceId: string;
  readonly taskId: string;
  readonly status: SchedulerTaskStatus;
  readonly checkpoint?: string;
  readonly consecutiveFailures: number;
  readonly lastScheduledFor?: IsoTimestamp;
  readonly lastStartedAt: IsoTimestamp;
  readonly lastCompletedAt?: IsoTimestamp;
  readonly lastFailureCategory?: string;
  readonly leaseOwner?: string;
  readonly claimToken?: string;
  readonly leaseExpiresAt?: IsoTimestamp;
}

const MAX_IDENTIFIER_LENGTH = 128;
const MAX_CHECKPOINT_LENGTH = 4_096;
const IDENTIFIER = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/;
const FAILURE_CATEGORY = /^[a-z][a-z0-9_]{0,63}$/;
const CONTROL_CHARACTERS = /[\u0000-\u001F\u007F]/;

function requireDataProperty(
  value: object,
  property: string,
  field: string,
): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, property);
  if (descriptor === undefined || !("value" in descriptor)) {
    throw new TypeError(`${field} must be an own data property`);
  }
  return descriptor.value;
}

function requireIdentifier(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    CONTROL_CHARACTERS.test(value) ||
    !IDENTIFIER.test(value)
  ) {
    throw new TypeError(
      `${field} must be a lowercase static identifier of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value;
}

function requireTimestamp(value: unknown, field: string): IsoTimestamp {
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (
    !Number.isFinite(milliseconds) ||
    new Date(milliseconds).toISOString() !== value
  ) {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return value as IsoTimestamp;
}

function optionalString(
  record: StoredRecord,
  field: string,
): string | undefined {
  const value = requireDataProperty(record, field, field);
  if (value === null) return undefined;
  if (typeof value !== "string") {
    throw new TypeError(`${field} must be a string or null`);
  }
  return value;
}

function optionalTimestamp(
  record: StoredRecord,
  field: string,
): IsoTimestamp | undefined {
  const value = requireDataProperty(record, field, field);
  return value === null ? undefined : requireTimestamp(value, field);
}

function decodeTaskState(record: StoredRecord): SchedulerTaskState {
  const schemaVersion = requireDataProperty(
    record,
    "schemaVersion",
    "schemaVersion",
  );
  if (schemaVersion !== 1) {
    throw new TypeError("schemaVersion must be 1");
  }

  const instanceId = requireIdentifier(
    requireDataProperty(record, "instanceId", "instanceId"),
    "instanceId",
  );
  const taskId = requireIdentifier(
    requireDataProperty(record, "taskId", "taskId"),
    "taskId",
  );
  const status = requireDataProperty(record, "status", "status");
  if (status !== "running" && status !== "succeeded" && status !== "failed") {
    throw new TypeError("status must be running, succeeded, or failed");
  }

  const failures = requireDataProperty(
    record,
    "consecutiveFailures",
    "consecutiveFailures",
  );
  if (!Number.isSafeInteger(failures) || (failures as number) < 0) {
    throw new TypeError("consecutiveFailures must be a non-negative integer");
  }

  const checkpoint = optionalString(record, "checkpoint");
  if (
    checkpoint !== undefined &&
    (checkpoint.length > MAX_CHECKPOINT_LENGTH ||
      CONTROL_CHARACTERS.test(checkpoint))
  ) {
    throw new TypeError(
      `checkpoint must be at most ${MAX_CHECKPOINT_LENGTH} characters with no controls`,
    );
  }

  const lastScheduledFor = optionalTimestamp(record, "lastScheduledFor");
  const lastStartedAt = requireTimestamp(
    requireDataProperty(record, "lastStartedAt", "lastStartedAt"),
    "lastStartedAt",
  );
  const lastCompletedAt = optionalTimestamp(record, "lastCompletedAt");
  const lastFailureCategory = optionalString(record, "lastFailureCategory");
  if (
    lastFailureCategory !== undefined &&
    !FAILURE_CATEGORY.test(lastFailureCategory)
  ) {
    throw new TypeError("lastFailureCategory must be a coarse safe token");
  }

  const leaseOwner = optionalString(record, "leaseOwner");
  const claimToken = optionalString(record, "claimToken");
  const leaseExpiresAt = optionalTimestamp(record, "leaseExpiresAt");
  const hasCompleteLease =
    leaseOwner !== undefined &&
    claimToken !== undefined &&
    leaseExpiresAt !== undefined;
  const hasAnyLease =
    leaseOwner !== undefined ||
    claimToken !== undefined ||
    leaseExpiresAt !== undefined;
  if (status === "running" ? !hasCompleteLease : hasAnyLease) {
    throw new TypeError(
      "running state requires a complete lease and terminal state forbids lease fields",
    );
  }

  return {
    schemaVersion: 1,
    instanceId,
    taskId,
    status,
    ...(checkpoint === undefined ? {} : { checkpoint }),
    consecutiveFailures: failures as number,
    ...(lastScheduledFor === undefined ? {} : { lastScheduledFor }),
    lastStartedAt,
    ...(lastCompletedAt === undefined ? {} : { lastCompletedAt }),
    ...(lastFailureCategory === undefined ? {} : { lastFailureCategory }),
    ...(leaseOwner === undefined ? {} : { leaseOwner }),
    ...(claimToken === undefined ? {} : { claimToken }),
    ...(leaseExpiresAt === undefined ? {} : { leaseExpiresAt }),
  };
}

function encodeTaskState(value: SchedulerTaskState): StoredRecord {
  const encoded: StoredRecord = {
    schemaVersion: value.schemaVersion,
    instanceId: value.instanceId,
    taskId: value.taskId,
    status: value.status,
    checkpoint: value.checkpoint ?? null,
    consecutiveFailures: value.consecutiveFailures,
    lastScheduledFor: value.lastScheduledFor ?? null,
    lastStartedAt: value.lastStartedAt,
    lastCompletedAt: value.lastCompletedAt ?? null,
    lastFailureCategory: value.lastFailureCategory ?? null,
    leaseOwner: value.leaseOwner ?? null,
    claimToken: value.claimToken ?? null,
    leaseExpiresAt: value.leaseExpiresAt ?? null,
  };
  decodeTaskState(encoded);
  return encoded;
}

export function schedulerTaskStateKey(
  instanceId: string,
  taskId: string,
): EntityKey {
  return {
    partition: requireIdentifier(instanceId, "instanceId"),
    id: requireIdentifier(taskId, "taskId"),
  };
}

/** Scheduler-owned state. Hosts supply the Store; tasks never write this row. */
export const schedulerTaskStates: CollectionDefinition<SchedulerTaskState> =
  defineCollection({
    name: "scheduler.task-state.v1",
    key: (value) => schedulerTaskStateKey(value.instanceId, value.taskId),
    codec: {
      encode: encodeTaskState,
      decode: decodeTaskState,
    },
  });

/**
 * Validates and freezes a static composition-root task registry while
 * preserving its literal task-id union for later runner calls.
 */
export function defineScheduledTasks<
  const TTasks extends Record<string, ScheduledTaskHandler>,
>(tasks: TTasks): DefinedScheduledTasks<TTasks> {
  if (tasks === null || typeof tasks !== "object" || Array.isArray(tasks)) {
    throw new TypeError("scheduled tasks must be an object");
  }
  const taskIds = Object.keys(tasks);
  if (taskIds.length === 0) {
    throw new TypeError("at least one scheduled task must be registered");
  }
  const copy = Object.create(null) as Record<string, ScheduledTaskHandler>;
  for (const taskId of taskIds) {
    requireIdentifier(taskId, "taskId");
    const handler = requireDataProperty(tasks, taskId, `task ${taskId}`);
    if (typeof handler !== "function") {
      throw new TypeError(`task ${taskId} must be a function`);
    }
    copy[taskId] = handler as ScheduledTaskHandler;
  }
  return Object.freeze(copy) as DefinedScheduledTasks<TTasks>;
}
