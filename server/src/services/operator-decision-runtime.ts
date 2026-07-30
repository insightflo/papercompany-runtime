import type { Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import { heartbeatService } from "./heartbeat.js";
import {
  operatorDecisionContinuationWorker,
  type OperatorDecisionHeartbeatAdmission,
} from "./operator-decision-continuation-worker.js";

const POLL_MS = 5_000;
const runtimes = new WeakMap<object, ReturnType<typeof createOperatorDecisionRuntime>>();

export function createOperatorDecisionRuntime(
  db: Db,
  heartbeat: OperatorDecisionHeartbeatAdmission = heartbeatService(db),
) {
  const worker = operatorDecisionContinuationWorker(db, { wakeup: heartbeat.wakeup });
  let timer: NodeJS.Timeout | null = null;
  let polling = false;

  async function pollOnce(now = new Date()) {
    if (polling) return 0;
    polling = true;
    try {
      return await worker.pollOnce(now);
    } finally {
      polling = false;
    }
  }

  function pollSafely() {
    void pollOnce().catch((error: unknown) => {
      logger.error({ err: error }, "operator decision continuation poll failed");
    });
  }

  function start() {
    if (timer) return;
    pollSafely();
    timer = setInterval(pollSafely, POLL_MS);
    timer.unref();
  }

  function stop() {
    if (!timer) return;
    clearInterval(timer);
    timer = null;
  }

  return { start, stop, pollOnce };
}

export function startOperatorDecisionRuntime(db: Db) {
  let runtime = runtimes.get(db as object);
  if (!runtime) {
    runtime = createOperatorDecisionRuntime(db);
    runtimes.set(db as object, runtime);
  }
  runtime.start();
  return runtime;
}
