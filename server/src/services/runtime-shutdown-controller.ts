import type { ViteDevServer } from "vite";

/** Rejected executions lack a positive durable disposition and remain visible to later drains. */
export function createWorkflowToolExecutionTracker() {
  const executions = new Set<Promise<unknown>>();
  const unresolvedFinalizations: unknown[] = [];

  return {
    track<T>(execution: Promise<T>): Promise<T> {
      let tracked!: Promise<T>;
      tracked = Promise.resolve(execution).then(
        (result) => {
          executions.delete(tracked);
          return result;
        },
        (error) => {
          unresolvedFinalizations.push(error);
          executions.delete(tracked);
          throw error;
        },
      );
      executions.add(tracked);
      return tracked;
    },
    async drain(): Promise<void> {
      while (executions.size > 0) await Promise.allSettled([...executions]);
      if (unresolvedFinalizations.length > 0) {
        throw new AggregateError(unresolvedFinalizations, "Workflow tool executions did not finalize cleanly during shutdown");
      }
    },
  };
}

/** Holds Vite acquired during startup so normal shutdown can close its HMR listener and watcher. */
export function createViteDevServerShutdownOwner() {
  let server: Pick<ViteDevServer, "close"> | null = null;
  return {
    attach(acquired: Pick<ViteDevServer, "close">) {
      server = acquired;
    },
    async close(): Promise<void> {
      const current = server;
      if (!current) return;
      await current.close();
      if (server === current) server = null;
    },
  };
}

export type AppRuntimeShutdown = {
  stopStarts(): void;
  drain(): Promise<void>;
  dispose(): Promise<void>;
  drainHttpProducers(): Promise<void>;
  sealHttpIngress(): void;
  drainHttpCallbacks(): Promise<void>;
};

export type RuntimeShutdownSignal = "SIGINT" | "SIGTERM";

/** Keep signal entry synchronous while all later work joins one process-local flight. */
export function createRuntimeShutdownFlight(input: {
  beginShutdown(signal: RuntimeShutdownSignal): void;
  stopIndexStarts(): void;
  stopAppStarts(): void;
  run(signal: RuntimeShutdownSignal): Promise<void>;
}): (signal: RuntimeShutdownSignal) => Promise<void> {
  let flight: Promise<void> | null = null;

  return (signal) => {
    if (flight) return flight;

    let resolveFlight!: () => void;
    let rejectFlight!: (error: unknown) => void;
    flight = new Promise<void>((resolve, reject) => {
      resolveFlight = resolve;
      rejectFlight = reject;
    });

    let stopFailed = false;
    let stopFailure: unknown;
    for (const action of [
      () => input.beginShutdown(signal),
      input.stopIndexStarts,
      input.stopAppStarts,
    ]) {
      try {
        action();
      } catch (error) {
        if (!stopFailed) stopFailure = error;
        stopFailed = true;
      }
    }
    if (stopFailed) {
      rejectFlight(stopFailure);
      return flight;
    }

    try {
      void Promise.resolve(input.run(signal)).then(resolveFlight, rejectFlight);
    } catch (error) {
      rejectFlight(error);
    }
    return flight;
  };
}

/** Enforces startup → producers → retained plugin results → execution/finalization drain order. */
export function createAppRuntimeShutdownController(input: {
  stopStarts(): void;
  drainStartup(): Promise<void>;
  drainProducers(): Promise<void>;
  shutdownPlugins(): Promise<void>;
  drainExecutions(): Promise<void>;
  drainHeartbeats(): Promise<void>;
  disposeResources(): Promise<void>;
  drainHttpProducers?: () => Promise<void>;
  sealHttpIngress?: () => void;
  drainHttpCallbacks?: () => Promise<void>;
}): AppRuntimeShutdown {
  let startsStopped = false;
  let startupFlight: Promise<void> | null = null;
  let producersFlight: Promise<void> | null = null;
  let pluginsFlight: Promise<void> | null = null;
  let drainFlight: Promise<void> | null = null;
  let disposeFlight: Promise<void> | null = null;

  const runOnce = (current: Promise<void> | null, run: () => Promise<void>) => current ?? run();
  const stopStarts = () => {
    if (startsStopped) return;
    startsStopped = true;
    input.stopStarts();
  };
  const drainHttpProducers = () => input.drainHttpProducers?.() ?? Promise.resolve();
  const sealHttpIngress = () => input.sealHttpIngress?.();
  const drainHttpCallbacks = () => input.drainHttpCallbacks?.() ?? Promise.resolve();
  const drain = (): Promise<void> => {
    stopStarts();
    if (drainFlight) return drainFlight;
    const current = (async () => {
      startupFlight = runOnce(startupFlight, input.drainStartup);
      await startupFlight;
      producersFlight = runOnce(producersFlight, input.drainProducers);
      await producersFlight;
      await drainHttpProducers();
      pluginsFlight = runOnce(pluginsFlight, input.shutdownPlugins);
      await pluginsFlight;
      const finalizationFailures: unknown[] = [];
      try {
        await input.drainExecutions();
      } catch (error) {
        finalizationFailures.push(error);
      }
      try {
        await input.drainHeartbeats();
      } catch (error) {
        finalizationFailures.push(error);
      }
      if (finalizationFailures.length === 1) throw finalizationFailures[0];
      if (finalizationFailures.length > 1) {
        throw new AggregateError(finalizationFailures, "Runtime execution finalization drain failed");
      }
    })();
    drainFlight = current;
    void current.then(
      () => { if (drainFlight === current) drainFlight = null; },
      () => {},
    );
    return current;
  };
  const dispose = (): Promise<void> => {
    if (disposeFlight) return disposeFlight;
    disposeFlight = (async () => {
      await drain();
      await input.disposeResources();
    })();
    return disposeFlight;
  };

  return { stopStarts, drain, dispose, drainHttpProducers, sealHttpIngress, drainHttpCallbacks };
}
