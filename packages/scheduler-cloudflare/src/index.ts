import type {
  Scheduler,
  SchedulerRunResult,
  ScheduledTaskDefinitions,
} from "@pegma/scheduler";

/**
 * Minimal ScheduledController surface. Cloudflare's runtime type is assignable
 * to this shape; the adapter does not import Workers types at runtime.
 */
export interface CloudflareScheduledController {
  /** Unix milliseconds for the scheduled occurrence (host time). */
  readonly scheduledTime: number;
  /** Cron expression that fired, as delivered by Cloudflare. */
  readonly cron: string;
}

/**
 * Minimal ExecutionContext surface used for waitUntil. Hosts pass the
 * platform context; tests can supply a recorder.
 */
export interface CloudflareExecutionContext {
  waitUntil(promise: Promise<unknown>): void;
}

/** Maps each Wrangler cron expression to one or more registered task ids. */
export type CronRouteMap<TTasks extends ScheduledTaskDefinitions> = Readonly<
  Record<string, readonly (keyof TTasks & string)[]>
>;

export interface CreateCloudflareSchedulerDispatchOptions<
  TTasks extends ScheduledTaskDefinitions,
> {
  readonly scheduler: Scheduler<TTasks>;
  /**
   * Explicit host-supplied routes. Keys must match Wrangler cron expressions
   * exactly. The adapter never discovers tasks or reads wrangler config.
   */
  readonly routes: CronRouteMap<TTasks>;
  /** Host-issued correlation id factory. Defaults to crypto.randomUUID(). */
  readonly newInvocationId?: () => string;
}

export interface CloudflareSchedulerDispatch<
  TTasks extends ScheduledTaskDefinitions,
> {
  /**
   * Dispatch one Cloudflare scheduled event through the route map.
   *
   * When `ctx` is provided, the returned work is also registered with
   * `waitUntil` so the isolate may outlive the handler return. The promise
   * always settles with one result per routed task, in route order.
   */
  scheduled(
    controller: CloudflareScheduledController,
    ctx?: CloudflareExecutionContext,
  ): Promise<readonly SchedulerRunResult[]>;
}

function requireRoutes<TTasks extends ScheduledTaskDefinitions>(
  routes: CronRouteMap<TTasks>,
): ReadonlyMap<string, readonly (keyof TTasks & string)[]> {
  if (routes === null || typeof routes !== "object" || Array.isArray(routes)) {
    throw new TypeError("routes must be an object");
  }
  const keys = Object.keys(routes);
  if (keys.length === 0) {
    throw new TypeError("at least one cron route must be registered");
  }
  const map = new Map<string, readonly (keyof TTasks & string)[]>();
  for (const cron of keys) {
    if (typeof cron !== "string" || cron.length === 0) {
      throw new TypeError("cron route keys must be non-empty strings");
    }
    const descriptor = Object.getOwnPropertyDescriptor(routes, cron);
    if (descriptor === undefined || !("value" in descriptor)) {
      throw new TypeError(`route ${cron} must be an own data property`);
    }
    const tasks = descriptor.value;
    if (!Array.isArray(tasks) || tasks.length === 0) {
      throw new TypeError(
        `route ${cron} must map to a non-empty array of task ids`,
      );
    }
    const copy: string[] = [];
    for (const taskId of tasks) {
      if (typeof taskId !== "string" || taskId.length === 0) {
        throw new TypeError(`route ${cron} task ids must be non-empty strings`);
      }
      copy.push(taskId);
    }
    map.set(cron, Object.freeze(copy) as readonly (keyof TTasks & string)[]);
  }
  return map;
}

function requireController(controller: CloudflareScheduledController): {
  readonly cron: string;
  readonly scheduledFor: string;
} {
  if (
    controller === null ||
    typeof controller !== "object" ||
    Array.isArray(controller)
  ) {
    throw new TypeError("scheduled controller must be an object");
  }
  const cron = controller.cron;
  if (typeof cron !== "string" || cron.length === 0) {
    throw new TypeError("controller.cron must be a non-empty string");
  }
  const scheduledTime = controller.scheduledTime;
  if (typeof scheduledTime !== "number" || !Number.isFinite(scheduledTime)) {
    throw new TypeError("controller.scheduledTime must be a finite number");
  }
  let scheduledFor: string;
  try {
    scheduledFor = new Date(scheduledTime).toISOString();
  } catch {
    throw new TypeError("controller.scheduledTime is not a valid instant");
  }
  return { cron, scheduledFor };
}

function defaultInvocationId(): string {
  const webCrypto = (
    globalThis as { readonly crypto?: { readonly randomUUID?: () => string } }
  ).crypto;
  if (webCrypto === undefined || typeof webCrypto.randomUUID !== "function") {
    throw new TypeError("crypto.randomUUID is required");
  }
  return webCrypto.randomUUID();
}

/**
 * Builds a thin Cloudflare Cron Trigger dispatcher over a core Scheduler.
 *
 * The host owns Wrangler cron configuration and the composition root. This
 * adapter only translates `ScheduledController` into explicit `runScheduled`
 * calls and keeps the isolate alive via `waitUntil` when an execution context
 * is supplied.
 */
export function createCloudflareSchedulerDispatch<
  TTasks extends ScheduledTaskDefinitions,
>(
  options: CreateCloudflareSchedulerDispatchOptions<TTasks>,
): CloudflareSchedulerDispatch<TTasks> {
  if (
    options === null ||
    typeof options !== "object" ||
    Array.isArray(options)
  ) {
    throw new TypeError("dispatch options must be an object");
  }
  if (
    options.scheduler === null ||
    typeof options.scheduler !== "object" ||
    typeof options.scheduler.runScheduled !== "function"
  ) {
    throw new TypeError("scheduler must provide runScheduled");
  }
  const routes = requireRoutes(options.routes);
  const newInvocationId = options.newInvocationId ?? defaultInvocationId;
  if (typeof newInvocationId !== "function") {
    throw new TypeError("newInvocationId must be a function");
  }

  return {
    async scheduled(controller, ctx) {
      const { cron, scheduledFor } = requireController(controller);
      const taskIds = routes.get(cron);
      if (taskIds === undefined) {
        throw new TypeError(
          `no scheduled tasks are routed for cron ${JSON.stringify(cron)}`,
        );
      }

      if (ctx !== undefined) {
        if (
          ctx === null ||
          typeof ctx !== "object" ||
          typeof ctx.waitUntil !== "function"
        ) {
          throw new TypeError("execution context must provide waitUntil");
        }
      }

      const work = (async (): Promise<readonly SchedulerRunResult[]> => {
        const results: SchedulerRunResult[] = [];
        for (const taskId of taskIds) {
          const result = await options.scheduler.runScheduled(taskId, {
            scheduledFor,
            invocationId: newInvocationId(),
          });
          results.push(result);
        }
        return Object.freeze(results);
      })();

      ctx?.waitUntil(work);
      return work;
    },
  };
}
