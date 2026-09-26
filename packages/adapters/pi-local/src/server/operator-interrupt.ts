import fs from "node:fs/promises";
import path from "node:path";

/**
 * Adapter-side consumer of the operator interrupt inbox.
 *
 * The Paperclip server writes <agentHome>/interrupts/issue-<issueId>.json when
 * a board user comments on an issue with an active run (see
 * server/src/services/operator-interrupt.ts). While a pi_local run is live we
 * poll that path and inject the payload into the child's stdin as an RPC
 * prompt command so the operator's message reaches the running session
 * immediately instead of the next wake prompt.
 *
 * The payload is an operator message to surface to the agent — it is not an
 * execution authority and nothing here parses it beyond strict JSON field
 * validation. Malformed files are left in place and warned about (fail
 * closed).
 */
export interface OperatorInterruptPayload {
  commentId: string;
  body: string;
  createdAt: string;
  issueId: string;
}

export function operatorInterruptFilePath(agentHome: string, issueId: string): string {
  return path.join(agentHome, "interrupts", `issue-${issueId}.json`);
}

export function buildOperatorInterruptPrompt(payload: OperatorInterruptPayload): string {
  return (
    `[OPERATOR INTERRUPT — highest priority, act on this now] ${payload.body.trim()} ` +
    `— 이 지시는 현재 작업 범위 내에서 우선 반영하라.`
  );
}

export function parseOperatorInterruptPayload(raw: string): OperatorInterruptPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const record = parsed as Record<string, unknown>;
  const commentId = typeof record.commentId === "string" ? record.commentId.trim() : "";
  const body = typeof record.body === "string" ? record.body : "";
  const createdAt = typeof record.createdAt === "string" ? record.createdAt.trim() : "";
  const issueId = typeof record.issueId === "string" ? record.issueId.trim() : "";
  if (!commentId || !body || !createdAt || !issueId) return null;
  return { commentId, body, createdAt, issueId };
}

export interface OperatorInterruptPollingOptions {
  agentHome: string;
  /** Candidate issue ids to poll (context.issueId, then context.taskId fallback). */
  issueIds: string[];
  /** Poll interval; production default 5s, tests use tens of ms. */
  intervalMs?: number;
  /** Returns false when the child stdin is gone; the file is then kept for retry. */
  writeStdin: (chunk: string) => boolean;
  onWarn?: (err: unknown, message: string) => void;
}

export interface OperatorInterruptPoller {
  stop: () => void;
}

export const DEFAULT_OPERATOR_INTERRUPT_POLL_MS = 5_000;

export function startOperatorInterruptPolling(opts: OperatorInterruptPollingOptions): OperatorInterruptPoller {
  const issueIds = [...new Set(opts.issueIds.filter((id) => id.trim().length > 0))];
  if (!opts.agentHome.trim() || issueIds.length === 0) {
    return { stop: () => {} };
  }
  const intervalMs =
    typeof opts.intervalMs === "number" && Number.isFinite(opts.intervalMs) && opts.intervalMs > 0
      ? opts.intervalMs
      : DEFAULT_OPERATOR_INTERRUPT_POLL_MS;

  let stopped = false;
  let ticking = false;
  let lastInjectedKey: string | null = null;

  const tick = async (): Promise<void> => {
    if (stopped || ticking) return;
    ticking = true;
    try {
      for (const issueId of issueIds) {
        const filePath = operatorInterruptFilePath(opts.agentHome, issueId);
        let raw: string;
        try {
          raw = await fs.readFile(filePath, "utf8");
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw err;
        }
        const payload = parseOperatorInterruptPayload(raw);
        if (!payload) {
          opts.onWarn?.(new Error("malformed operator interrupt payload"), `operator interrupt file ignored: ${filePath}`);
          continue;
        }
        const key = `${payload.issueId}:${payload.commentId}:${payload.createdAt}`;
        if (key === lastInjectedKey) continue;
        // Inject first, consume second: if the child stdin is already gone the
        // file stays on disk (and the wakeup path still delivers the comment),
        // so a successful write never loses the interrupt.
        const line = JSON.stringify({ type: "prompt", message: buildOperatorInterruptPrompt(payload) }) + "\n";
        if (!opts.writeStdin(line)) continue;
        lastInjectedKey = key;
        await fs.rm(filePath, { force: true });
      }
    } catch (err) {
      opts.onWarn?.(err, "operator interrupt polling failed");
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => {
    void tick();
  }, intervalMs);
  // Catch files written while the run was queued before the first interval fires.
  void tick();

  return {
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
