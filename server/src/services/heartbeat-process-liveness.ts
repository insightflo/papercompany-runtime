// A positive liveness check means some process currently owns the PID.
// On Linux, PIDs can be recycled, so this is a best-effort signal rather
// than proof that the original child is still alive.
export function isProcessAlive(pid: number | null | undefined) {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "EPERM") return true;
    if (code === "ESRCH") return false;
    return false;
  }
}

export function terminateRecordedProcess(pid: number | null | undefined, signal: NodeJS.Signals = "SIGTERM") {
  if (!isProcessAlive(pid)) return false;
  try {
    process.kill(pid as number, signal);
    return true;
  } catch {
    return false;
  }
}

const SESSIONED_LOCAL_ADAPTERS = new Set([
  "claude_local",
  "codex_local",
  "cursor",
  "gemini_local",
  "opencode_local",
  "pi_local",
  "commandcode_local",
]);

export function isTrackedLocalChildProcessAdapter(adapterType: string) {
  return SESSIONED_LOCAL_ADAPTERS.has(adapterType);
}

export const DETACHED_PROCESS_ERROR_CODE = "process_detached";
// orphaned-but-alive child 강제 회수 시한. handle 상실 후에도 child pid 가 살아 reaper 가 process_detached
// 로 매 tick defer 만 하던 무한 대기(CMPA-5519 ~72분 hang)를 상한으로 끊고 process_lost+retry 로 회수.
export const DETACHED_REAP_AFTER_MS = 30 * 60 * 1000;
export const DETACHED_GRACE_SEC = 5;
// [paperclip-stuck 2026-08-06, A2] detached 유예 창 동안 agents.status 가 `running`에 갇히는
// (phantom running) 것을 끊는다. reapOrphanedRuns 는 detached child 를 DETACHED_REAP_AFTER_MS 까지
// 유예하지만, 그 동안 finalizeAgentStatus 가 호출되지 않아 agent 가 최장 30분간 running 으로 보임.
// agent.updatedAt 기준으로 이 임계를 넘기면 agent 를 `error` 로 강등해 보드/QA 가 실상을 반영하게 한다.
// (run 자체는 longevity cap 에 따라 별도 회수 — 여기서는 agent 가시성만 교정.)
export const HEARTBEAT_AGENT_DETACHED_DEMOTE_MS = 10 * 60 * 1000;
