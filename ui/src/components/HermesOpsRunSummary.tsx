// ui/src/components/HermesOpsRunSummary.tsx
//
// [파일 목적] Hermes Ops run(chat-sidebar / chat-telegram / monitor)을 열었을 때
//   operator question · compact recovery evidence · final answer · raw-log 안내를
//   한 화면에서 읽히는 dense operational summary로 렌더.
// [주요 흐름] run.resultJson.hermesRunKind가 없으면 null(비-hermes run엔 미출력).
//   advice는 nested resultJson.recoveryAdvice에서만 읽는다(top-level decision 금지 invariant).
// [외부 연결] AgentDetail.tsx가 run을 넘겨줌. 기존 transcript/raw-log 접근은 보존(이 컴포넌트는 요약만).
import { cn } from "../lib/utils";

type HermesRun = {
  id?: string;
  resultJson?: unknown;
  contextSnapshot?: unknown;
  logRef?: string | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

const KIND_LABEL: Record<string, string> = {
  "chat-sidebar": "Chat - sidebar",
  "chat-telegram": "Chat - Telegram",
  monitor: "Monitor sweep",
};

const KIND_TONE: Record<string, string> = {
  "chat-sidebar": "bg-sky-500/10 text-sky-700 dark:text-sky-300 border-sky-500/20",
  "chat-telegram": "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300 border-emerald-500/20",
  monitor: "bg-violet-500/10 text-violet-700 dark:text-violet-300 border-violet-500/20",
};

export function HermesOpsRunSummary({ run }: { run: HermesRun }) {
  const result = asRecord(run.resultJson);
  const kind = asString(result?.hermesRunKind);
  if (!kind) return null; // 비-hermes run — 출력 없음

  const advice = asRecord(result?.recoveryAdvice);
  const context = asRecord(run.contextSnapshot);
  const chat = asRecord(context?.paperclipHermesChat);
  const question = asString(chat?.currentMessage);
  const answer = asString(result?.result);

  const decision = asString(advice?.decision);
  const target = asRecord(advice?.targetIssue);
  const targetIdentifier = asString(target?.identifier) ?? asString(target?.id);
  const targetRole = asString(target?.role);
  const targetTitle = asString(target?.title);
  const targetAction = asString(advice?.targetAction);
  const leafCause = asString(advice?.leafCause);
  const operatorComment = asString(advice?.operatorComment);
  const evidence = Array.isArray(advice?.evidence)
    ? (advice.evidence as unknown[]).filter((e) => typeof e === "object" && e !== null)
    : [];
  const doNot = Array.isArray(advice?.doNot) ? (advice.doNot as unknown[]).filter((e) => typeof e === "string") : [];
  const missing = Array.isArray(advice?.missingEvidence)
    ? (advice.missingEvidence as unknown[]).filter((e) => typeof e === "string")
    : [];

  return (
    <div className="rounded-2xl border border-border/70 bg-background/40 p-3 sm:p-4 space-y-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium",
              KIND_TONE[kind] ?? "bg-muted text-muted-foreground border-border",
            )}
          >
            Hermes Ops - {KIND_LABEL[kind] ?? kind}
          </span>
          {decision && (
            <span className="text-[11px] font-mono text-muted-foreground">
              decision={decision}
            </span>
          )}
        </div>
        {run.id && run.logRef ? (
          <a
            href={`/api/heartbeat-runs/${run.id}/log?offset=0&limitBytes=256000`}
            target="_blank"
            rel="noreferrer"
            className="text-[11px] text-sky-600 hover:underline dark:text-sky-400"
          >
            raw log
          </a>
        ) : null}
      </div>

      {question && (
        <div className="text-xs">
          <span className="text-muted-foreground">Q </span>
          <span className="text-foreground">{question}</span>
        </div>
      )}

      {advice && (
        <div className="rounded-xl border border-border/60 bg-muted/30 p-2.5 space-y-1.5">
          {targetIdentifier && (
            <div className="text-xs">
              <span className="text-muted-foreground">Target </span>
              <span className="font-medium text-foreground">
                {targetIdentifier}
                {targetRole ? <span className="text-muted-foreground"> ({targetRole})</span> : null}
              </span>
              {targetAction ? <span className="text-muted-foreground"> · action: {targetAction}</span> : null}
              {targetTitle ? <span className="text-muted-foreground"> · {targetTitle}</span> : null}
            </div>
          )}
          {leafCause && (
            <div className="text-xs text-foreground">
              <span className="text-muted-foreground">Leaf cause </span>
              {leafCause}
            </div>
          )}
          {evidence.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
              {evidence.slice(0, 4).map((e, i) => {
                const rec = e as Record<string, unknown>;
                const label = asString(rec.label) ?? "evidence";
                const value = asString(rec.value);
                return <li key={i}>{value ? `${label}: ${value}` : label}</li>;
              })}
            </ul>
          )}
          {operatorComment && (
            <pre className="text-xs whitespace-pre-wrap text-foreground bg-background/60 rounded-md p-2">
              {operatorComment}
            </pre>
          )}
          {doNot.length > 0 && (
            <div className="text-xs text-amber-700 dark:text-amber-300">
              <span className="font-medium">Do NOT: </span>
              {(doNot as string[]).slice(0, 3).join(" / ")}
            </div>
          )}
          {missing.length > 0 && (
            <div className="text-xs text-muted-foreground">
              <span className="font-medium">Missing evidence: </span>
              {(missing as string[]).slice(0, 3).join(" / ")}
            </div>
          )}
        </div>
      )}

      {answer && (
        <div className="text-xs">
          <span className="text-muted-foreground">A </span>
          <span className="text-foreground">{answer.length > 280 ? `${answer.slice(0, 280)}...` : answer}</span>
        </div>
      )}
    </div>
  );
}
