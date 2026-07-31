import type { Clock, IsoTimestamp, Logger } from "@pegma/spine";
import {
  defineCollection,
  type CollectionDefinition,
  type CollectionStore,
  type EntityKey,
  type Store,
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
  // Backends such as Azure Tables write null by omission. A missing own
  // property is therefore equivalent to null for optional fields.
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return undefined;
  }
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
  if (!Object.prototype.hasOwnProperty.call(record, field)) {
    return undefined;
  }
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

/** Default claim duration. Hosts may raise it for longer bounded pages. */
export const DEFAULT_LEASE_MILLISECONDS = 30_000;
/** Hard upper bound accepted for a single claim. */
export const MAX_LEASE_MILLISECONDS = 86_400_000;
/** Default headroom between handler timeout and lease expiry. */
export const DEFAULT_HANDLER_TIMEOUT_HEADROOM_MILLISECONDS = 1_000;

export type SchedulerSkipReason = "live_lease" | "stale_occurrence";

export type SchedulerRunResult =
  | {
      readonly outcome: "skipped";
      readonly reason: SchedulerSkipReason;
      readonly state: SchedulerTaskState | null;
    }
  | {
      readonly outcome: "succeeded";
      readonly state: SchedulerTaskState;
      readonly result: ScheduledTaskResult;
    }
  | {
      readonly outcome: "failed";
      readonly state: SchedulerTaskState;
      readonly failureCategory: string;
    }
  | {
      readonly outcome: "stale_completion";
      readonly state: SchedulerTaskState | null;
    };

export interface ScheduledInvocation {
  /** Trusted host time for the scheduled occurrence, not provider time. */
  readonly scheduledFor: IsoTimestamp;
  /** Host-issued identifier for diagnostics and execution correlation. */
  readonly invocationId: string;
}

export interface ManualInvocation {
  /** Host-issued identifier for diagnostics and execution correlation. */
  readonly invocationId: string;
}

export type FailureClassifier = (error: unknown) => string;

export interface CreateSchedulerOptions<
  TTasks extends ScheduledTaskDefinitions,
> {
  readonly store: Store;
  readonly clock: Clock;
  readonly logger: Logger;
  /** Isolates durable state for one deployed composition. */
  readonly instanceId: string;
  /** Identifies this worker process or isolate for lease ownership. */
  readonly workerId: string;
  readonly tasks: DefinedScheduledTasks<TTasks> | TTasks;
  /**
   * Claim duration, not an I/O timeout. The handler must settle before the
   * lease expires so fenced completion can still land.
   */
  readonly leaseMilliseconds?: number;
  /**
   * Wall-clock budget for the handler. Defaults to the lease minus one second
   * of completion headroom (or the full lease when it is shorter).
   */
  readonly handlerTimeoutMilliseconds?: number;
  /** Maps thrown values to a coarse, content-free failure category. */
  readonly classifyFailure?: FailureClassifier;
}

export interface Scheduler<TTasks extends ScheduledTaskDefinitions> {
  /** Invoke a registered task for a host-delivered scheduled occurrence. */
  runScheduled(
    taskId: keyof TTasks & string,
    invocation: ScheduledInvocation,
  ): Promise<SchedulerRunResult>;
  /**
   * Invoke a registered task outside monotonic scheduled occurrence
   * suppression. Still shares the same task lease.
   */
  runManual(
    taskId: keyof TTasks & string,
    invocation: ManualInvocation,
  ): Promise<SchedulerRunResult>;
  /** Keyed inspection of durable task state for this instance. */
  getState(taskId: keyof TTasks & string): Promise<SchedulerTaskState | null>;
}

const MAX_SUMMARY_KEYS = 32;
const MAX_SUMMARY_KEY_LENGTH = 64;
const MAX_DATE_EPOCH_MILLISECONDS = 8_640_000_000_000_000;

function requireBoundedText(value: unknown, field: string): string {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_IDENTIFIER_LENGTH ||
    CONTROL_CHARACTERS.test(value)
  ) {
    throw new TypeError(
      `${field} must be a non-empty string of at most ${MAX_IDENTIFIER_LENGTH} characters`,
    );
  }
  return value;
}

function requirePositiveInteger(
  value: unknown,
  field: string,
  maximum: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > maximum
  ) {
    throw new TypeError(
      `${field} must be an integer between 1 and ${maximum} inclusive`,
    );
  }
  return value;
}

function requireTimestampField(value: unknown, field: string): IsoTimestamp {
  return requireTimestamp(value, field);
}

function epochMilliseconds(value: IsoTimestamp, field: string): number {
  const milliseconds = Date.parse(value);
  if (!Number.isFinite(milliseconds)) {
    throw new TypeError(`${field} must be a canonical UTC ISO timestamp`);
  }
  return milliseconds;
}

function at(milliseconds: number): IsoTimestamp {
  if (
    !Number.isFinite(milliseconds) ||
    milliseconds < 0 ||
    milliseconds > MAX_DATE_EPOCH_MILLISECONDS
  ) {
    throw new TypeError("timestamp is out of the representable range");
  }
  return new Date(milliseconds).toISOString() as IsoTimestamp;
}

function newClaimToken(): string {
  const webCrypto = globalThis.crypto as
    { readonly randomUUID?: () => string } | undefined;
  if (webCrypto === undefined || typeof webCrypto.randomUUID !== "function") {
    throw new TypeError("crypto.randomUUID is required");
  }
  return webCrypto.randomUUID();
}

function leaseIsLive(state: SchedulerTaskState, nowEpoch: number): boolean {
  return (
    state.status === "running" &&
    state.leaseExpiresAt !== undefined &&
    epochMilliseconds(state.leaseExpiresAt, "leaseExpiresAt") > nowEpoch
  );
}

function isStaleOccurrence(
  state: SchedulerTaskState,
  scheduledFor: IsoTimestamp,
): boolean {
  if (state.lastScheduledFor === undefined) {
    return false;
  }
  return (
    epochMilliseconds(scheduledFor, "scheduledFor") <=
    epochMilliseconds(state.lastScheduledFor, "lastScheduledFor")
  );
}

function withoutLease(
  state: SchedulerTaskState,
): Omit<SchedulerTaskState, "leaseOwner" | "claimToken" | "leaseExpiresAt"> {
  const {
    leaseOwner: _leaseOwner,
    claimToken: _claimToken,
    leaseExpiresAt: _leaseExpiresAt,
    ...rest
  } = state;
  return rest;
}

function normalizeHandlerResult(value: unknown): ScheduledTaskResult | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const result: {
    nextCheckpoint?: string | null;
    more?: boolean;
    summary?: Readonly<Record<string, number>>;
  } = {};

  if (Object.prototype.hasOwnProperty.call(record, "nextCheckpoint")) {
    const checkpoint = record["nextCheckpoint"];
    if (checkpoint === null) {
      result.nextCheckpoint = null;
    } else if (
      typeof checkpoint === "string" &&
      checkpoint.length <= MAX_CHECKPOINT_LENGTH &&
      !CONTROL_CHARACTERS.test(checkpoint)
    ) {
      result.nextCheckpoint = checkpoint;
    } else {
      return null;
    }
  }

  if (Object.prototype.hasOwnProperty.call(record, "more")) {
    if (typeof record["more"] !== "boolean") {
      return null;
    }
    result.more = record["more"];
  }

  if (Object.prototype.hasOwnProperty.call(record, "summary")) {
    const summary = record["summary"];
    if (
      summary === null ||
      typeof summary !== "object" ||
      Array.isArray(summary)
    ) {
      return null;
    }
    const keys = Object.keys(summary as object);
    if (keys.length > MAX_SUMMARY_KEYS) {
      return null;
    }
    const normalized: Record<string, number> = Object.create(null) as Record<
      string,
      number
    >;
    for (const key of keys) {
      if (
        key.length === 0 ||
        key.length > MAX_SUMMARY_KEY_LENGTH ||
        CONTROL_CHARACTERS.test(key) ||
        !FAILURE_CATEGORY.test(key)
      ) {
        return null;
      }
      const count = (summary as Record<string, unknown>)[key];
      if (typeof count !== "number" || !Number.isSafeInteger(count)) {
        return null;
      }
      normalized[key] = count;
    }
    result.summary = Object.freeze(normalized);
  }

  return result;
}

function applyCheckpoint(
  current: string | undefined,
  nextCheckpoint: string | null | undefined,
): string | undefined {
  if (nextCheckpoint === undefined) {
    return current;
  }
  if (nextCheckpoint === null) {
    return undefined;
  }
  return nextCheckpoint;
}

function createTimeout(milliseconds: number): {
  readonly promise: Promise<"timeout">;
  cancel(): void;
} {
  let handle: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  const promise = new Promise<"timeout">((resolve) => {
    handle = setTimeout(() => {
      finished = true;
      handle = undefined;
      resolve("timeout");
    }, milliseconds);
    // Node may keep the process alive for a pending timer; clearTimeout is the
    // primary fix, and unref is a best-effort extra on hosts that support it.
    const timer = handle as { unref?: () => void };
    if (typeof timer.unref === "function") {
      timer.unref();
    }
  });
  return {
    promise,
    cancel() {
      if (handle !== undefined && !finished) {
        clearTimeout(handle);
        handle = undefined;
      }
    },
  };
}

/**
 * Builds a durable scheduler over an injected Store, Clock, and Logger.
 *
 * The host owns wakeups and supplies occurrence times. This runner owns
 * claim, lease recovery, checkpoint advancement, and safe run state.
 */
export function createScheduler<
  const TTasks extends Record<string, ScheduledTaskHandler>,
>(options: CreateSchedulerOptions<TTasks>): Scheduler<TTasks> {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypeError("scheduler options must be an object");
  }

  const instanceId = requireIdentifier(options.instanceId, "instanceId");
  const workerId = requireBoundedText(options.workerId, "workerId");
  const leaseMilliseconds = requirePositiveInteger(
    options.leaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS,
    "leaseMilliseconds",
    MAX_LEASE_MILLISECONDS,
  );
  const defaultHandlerTimeout = Math.max(
    1,
    leaseMilliseconds - DEFAULT_HANDLER_TIMEOUT_HEADROOM_MILLISECONDS,
  );
  const handlerTimeoutMilliseconds = requirePositiveInteger(
    options.handlerTimeoutMilliseconds ?? defaultHandlerTimeout,
    "handlerTimeoutMilliseconds",
    leaseMilliseconds,
  );
  if (handlerTimeoutMilliseconds > leaseMilliseconds) {
    throw new TypeError(
      "handlerTimeoutMilliseconds must not exceed leaseMilliseconds",
    );
  }

  const tasks = defineScheduledTasks(
    options.tasks as Record<string, ScheduledTaskHandler>,
  ) as DefinedScheduledTasks<TTasks>;
  const states: CollectionStore<SchedulerTaskState> =
    options.store.collection(schedulerTaskStates);
  const classifyFailure: FailureClassifier =
    options.classifyFailure ?? (() => "handler_failed");

  function clockNow(): { readonly text: IsoTimestamp; readonly epoch: number } {
    const text = requireTimestampField(options.clock.now(), "clock.now()");
    return { text, epoch: epochMilliseconds(text, "clock.now()") };
  }

  function completionNow(claimEpoch: number): {
    readonly text: IsoTimestamp;
    readonly epoch: number;
  } {
    const completed = clockNow();
    if (completed.epoch < claimEpoch) {
      throw new TypeError("clock.now() moved backward during task work");
    }
    return completed;
  }

  function failureCategoryFor(error: unknown): string {
    try {
      const classified = classifyFailure(error);
      return typeof classified === "string" && FAILURE_CATEGORY.test(classified)
        ? classified
        : "handler_failed";
    } catch {
      return "handler_failed";
    }
  }

  function requireTask(taskId: string): {
    readonly taskId: string;
    readonly handler: ScheduledTaskHandler;
  } {
    requireIdentifier(taskId, "taskId");
    const handler = (tasks as Record<string, ScheduledTaskHandler | undefined>)[
      taskId
    ];
    if (handler === undefined) {
      throw new TypeError(`task ${taskId} is not registered`);
    }
    return { taskId, handler };
  }

  async function readState(taskId: string): Promise<SchedulerTaskState | null> {
    return states.get(schedulerTaskStateKey(instanceId, taskId));
  }

  function log(
    level: "info" | "warn" | "error",
    message: string,
    fields: Readonly<Record<string, unknown>>,
  ): void {
    options.logger.log(level, message, {
      component: "scheduler",
      instanceId,
      workerId,
      ...fields,
    });
  }

  async function claim(input: {
    readonly taskId: string;
    readonly mode: "scheduled" | "manual";
    readonly scheduledFor: IsoTimestamp;
    readonly invocationId: string;
    readonly now: IsoTimestamp;
    readonly nowEpoch: number;
    readonly leaseExpiresAt: IsoTimestamp;
    readonly claimToken: string;
  }): Promise<
    | { readonly status: "claimed"; readonly state: SchedulerTaskState }
    | {
        readonly status: "skipped";
        readonly reason: SchedulerSkipReason;
        readonly state: SchedulerTaskState | null;
      }
  > {
    const key = schedulerTaskStateKey(instanceId, input.taskId);
    const result = await states.update(key, (current) => {
      if (current !== null) {
        if (
          current.instanceId !== instanceId ||
          current.taskId !== input.taskId
        ) {
          return { action: "keep" };
        }
        if (leaseIsLive(current, input.nowEpoch)) {
          return { action: "keep" };
        }
        if (
          input.mode === "scheduled" &&
          isStaleOccurrence(current, input.scheduledFor)
        ) {
          return { action: "keep" };
        }
      }

      const base: SchedulerTaskState =
        current === null
          ? {
              schemaVersion: 1,
              instanceId,
              taskId: input.taskId,
              status: "running",
              consecutiveFailures: 0,
              lastStartedAt: input.now,
              leaseOwner: workerId,
              claimToken: input.claimToken,
              leaseExpiresAt: input.leaseExpiresAt,
            }
          : {
              ...withoutLease(current),
              status: "running",
              lastStartedAt: input.now,
              leaseOwner: workerId,
              claimToken: input.claimToken,
              leaseExpiresAt: input.leaseExpiresAt,
            };

      return { action: "write", value: base };
    });

    if (result.written && result.value !== null) {
      if (result.value.claimToken !== input.claimToken) {
        // Another decider attempt minted a different token; treat as lost claim.
        const reason: SchedulerSkipReason = leaseIsLive(
          result.value,
          input.nowEpoch,
        )
          ? "live_lease"
          : "stale_occurrence";
        return { status: "skipped", reason, state: result.value };
      }
      return { status: "claimed", state: result.value };
    }

    const state = result.value ?? (await readState(input.taskId));
    if (state !== null && leaseIsLive(state, input.nowEpoch)) {
      return { status: "skipped", reason: "live_lease", state };
    }
    if (
      input.mode === "scheduled" &&
      state !== null &&
      isStaleOccurrence(state, input.scheduledFor)
    ) {
      return { status: "skipped", reason: "stale_occurrence", state };
    }
    return {
      status: "skipped",
      reason:
        state !== null && leaseIsLive(state, input.nowEpoch)
          ? "live_lease"
          : "stale_occurrence",
      state,
    };
  }

  async function complete(input: {
    readonly taskId: string;
    readonly mode: "scheduled" | "manual";
    readonly scheduledFor: IsoTimestamp;
    readonly claimToken: string;
    readonly now: IsoTimestamp;
    readonly success: boolean;
    readonly nextCheckpoint?: string | null;
    readonly failureCategory?: string;
  }): Promise<SchedulerTaskState | null> {
    const key = schedulerTaskStateKey(instanceId, input.taskId);
    const result = await states.update(key, (current) => {
      if (
        current === null ||
        current.status !== "running" ||
        current.leaseOwner !== workerId ||
        current.claimToken !== input.claimToken
      ) {
        return { action: "keep" };
      }

      const unclaimed = withoutLease(current);
      const lastScheduledFor =
        input.mode === "scheduled"
          ? input.scheduledFor
          : unclaimed.lastScheduledFor;

      if (input.success) {
        const checkpoint = applyCheckpoint(
          unclaimed.checkpoint,
          input.nextCheckpoint,
        );
        const succeeded: SchedulerTaskState = {
          schemaVersion: 1,
          instanceId: unclaimed.instanceId,
          taskId: unclaimed.taskId,
          status: "succeeded",
          consecutiveFailures: 0,
          lastStartedAt: unclaimed.lastStartedAt,
          lastCompletedAt: input.now,
          ...(checkpoint === undefined ? {} : { checkpoint }),
          ...(lastScheduledFor === undefined ? {} : { lastScheduledFor }),
        };
        return { action: "write", value: succeeded };
      }

      const failed: SchedulerTaskState = {
        schemaVersion: 1,
        instanceId: unclaimed.instanceId,
        taskId: unclaimed.taskId,
        status: "failed",
        consecutiveFailures: unclaimed.consecutiveFailures + 1,
        lastStartedAt: unclaimed.lastStartedAt,
        lastCompletedAt: input.now,
        lastFailureCategory: input.failureCategory ?? "handler_failed",
        ...(unclaimed.checkpoint === undefined
          ? {}
          : { checkpoint: unclaimed.checkpoint }),
        ...(unclaimed.lastScheduledFor === undefined
          ? {}
          : { lastScheduledFor: unclaimed.lastScheduledFor }),
      };
      return { action: "write", value: failed };
    });

    return result.written ? result.value : null;
  }

  async function invoke(input: {
    readonly taskId: string;
    readonly handler: ScheduledTaskHandler;
    readonly mode: "scheduled" | "manual";
    readonly scheduledFor: IsoTimestamp;
    readonly invocationId: string;
  }): Promise<SchedulerRunResult> {
    const started = clockNow();
    if (started.epoch > MAX_DATE_EPOCH_MILLISECONDS - leaseMilliseconds) {
      throw new TypeError("now is too late to represent a bounded lease");
    }

    const claimToken = newClaimToken();
    const leaseExpiresAt = at(started.epoch + leaseMilliseconds);
    const claimed = await claim({
      taskId: input.taskId,
      mode: input.mode,
      scheduledFor: input.scheduledFor,
      invocationId: input.invocationId,
      now: started.text,
      nowEpoch: started.epoch,
      leaseExpiresAt,
      claimToken,
    });

    if (claimed.status === "skipped") {
      log("info", "scheduler.task.skipped", {
        taskId: input.taskId,
        mode: input.mode,
        reason: claimed.reason,
        invocationId: input.invocationId,
        scheduledFor: input.scheduledFor,
      });
      return {
        outcome: "skipped",
        reason: claimed.reason,
        state: claimed.state,
      };
    }

    // Claim I/O may consume lease budget; re-sample the clock and never run a
    // handler after the durable lease has already expired.
    const afterClaim = clockNow();
    if (afterClaim.epoch < started.epoch) {
      throw new TypeError("clock.now() moved backward during claim");
    }
    const leaseExpiresEpoch = started.epoch + leaseMilliseconds;
    const remainingLeaseMilliseconds = leaseExpiresEpoch - afterClaim.epoch;

    log("info", "scheduler.task.claimed", {
      taskId: input.taskId,
      mode: input.mode,
      invocationId: input.invocationId,
      scheduledFor: input.scheduledFor,
      leaseExpiresAt,
      claimToken,
      remainingLeaseMilliseconds,
    });

    let handlerOutcome:
      | { readonly kind: "result"; readonly result: ScheduledTaskResult }
      | { readonly kind: "failure"; readonly category: string };

    if (remainingLeaseMilliseconds <= 0) {
      handlerOutcome = { kind: "failure", category: "lease_exhausted" };
    } else {
      const context: ScheduledTaskContext = {
        scheduledFor: input.scheduledFor,
        invocationId: input.invocationId,
        ...(claimed.state.checkpoint === undefined
          ? {}
          : { checkpoint: claimed.state.checkpoint }),
      };
      const effectiveTimeoutMilliseconds = Math.min(
        handlerTimeoutMilliseconds,
        remainingLeaseMilliseconds,
      );
      const timeout = createTimeout(effectiveTimeoutMilliseconds);
      try {
        const settled = await Promise.race([
          input.handler(context).then(
            (value) => ({ kind: "settled" as const, value }) as const,
            (error: unknown) => ({ kind: "rejected" as const, error }) as const,
          ),
          timeout.promise,
        ]);
        timeout.cancel();

        if (settled === "timeout") {
          handlerOutcome = { kind: "failure", category: "handler_timeout" };
        } else if (settled.kind === "rejected") {
          handlerOutcome = {
            kind: "failure",
            category: failureCategoryFor(settled.error),
          };
        } else {
          const normalized = normalizeHandlerResult(settled.value);
          if (normalized === null) {
            handlerOutcome = {
              kind: "failure",
              category: "handler_result_invalid",
            };
          } else {
            handlerOutcome = { kind: "result", result: normalized };
          }
        }
      } catch (error) {
        timeout.cancel();
        handlerOutcome = {
          kind: "failure",
          category: failureCategoryFor(error),
        };
      }
    }

    const finished = completionNow(started.epoch);

    if (handlerOutcome.kind === "result") {
      const state = await complete({
        taskId: input.taskId,
        mode: input.mode,
        scheduledFor: input.scheduledFor,
        claimToken,
        now: finished.text,
        success: true,
        ...(Object.prototype.hasOwnProperty.call(
          handlerOutcome.result,
          "nextCheckpoint",
        )
          ? { nextCheckpoint: handlerOutcome.result.nextCheckpoint }
          : {}),
      });
      if (state === null) {
        const current = await readState(input.taskId);
        log("warn", "scheduler.task.stale_completion", {
          taskId: input.taskId,
          mode: input.mode,
          invocationId: input.invocationId,
          scheduledFor: input.scheduledFor,
          claimToken,
        });
        return { outcome: "stale_completion", state: current };
      }
      log("info", "scheduler.task.succeeded", {
        taskId: input.taskId,
        mode: input.mode,
        invocationId: input.invocationId,
        scheduledFor: input.scheduledFor,
        more: handlerOutcome.result.more ?? false,
        ...(handlerOutcome.result.summary === undefined
          ? {}
          : { summary: handlerOutcome.result.summary }),
        ...(state.checkpoint === undefined ? {} : { checkpointPresent: true }),
      });
      return {
        outcome: "succeeded",
        state,
        result: handlerOutcome.result,
      };
    }

    const state = await complete({
      taskId: input.taskId,
      mode: input.mode,
      scheduledFor: input.scheduledFor,
      claimToken,
      now: finished.text,
      success: false,
      failureCategory: handlerOutcome.category,
    });
    if (state === null) {
      const current = await readState(input.taskId);
      log("warn", "scheduler.task.stale_completion", {
        taskId: input.taskId,
        mode: input.mode,
        invocationId: input.invocationId,
        scheduledFor: input.scheduledFor,
        claimToken,
        failureCategory: handlerOutcome.category,
      });
      return { outcome: "stale_completion", state: current };
    }
    log("warn", "scheduler.task.failed", {
      taskId: input.taskId,
      mode: input.mode,
      invocationId: input.invocationId,
      scheduledFor: input.scheduledFor,
      failureCategory: handlerOutcome.category,
      consecutiveFailures: state.consecutiveFailures,
    });
    return {
      outcome: "failed",
      state,
      failureCategory: handlerOutcome.category,
    };
  }

  return {
    async runScheduled(taskId, invocation) {
      const task = requireTask(taskId);
      if (
        invocation === null ||
        typeof invocation !== "object" ||
        Array.isArray(invocation)
      ) {
        throw new TypeError("scheduled invocation must be an object");
      }
      const scheduledFor = requireTimestampField(
        invocation.scheduledFor,
        "scheduledFor",
      );
      const invocationId = requireBoundedText(
        invocation.invocationId,
        "invocationId",
      );
      return invoke({
        taskId: task.taskId,
        handler: task.handler,
        mode: "scheduled",
        scheduledFor,
        invocationId,
      });
    },

    async runManual(taskId, invocation) {
      const task = requireTask(taskId);
      if (
        invocation === null ||
        typeof invocation !== "object" ||
        Array.isArray(invocation)
      ) {
        throw new TypeError("manual invocation must be an object");
      }
      const invocationId = requireBoundedText(
        invocation.invocationId,
        "invocationId",
      );
      const scheduledFor = clockNow().text;
      return invoke({
        taskId: task.taskId,
        handler: task.handler,
        mode: "manual",
        scheduledFor,
        invocationId,
      });
    },

    async getState(taskId) {
      const task = requireTask(taskId);
      return readState(task.taskId);
    },
  };
}
