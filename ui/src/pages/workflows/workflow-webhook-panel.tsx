// ui/src/pages/workflows/workflow-webhook-panel.tsx
//
// [purpose] 워크플로 웹훅 관리 패널 — 선택된 워크플로 정의에 대한 외부 서명 호출 트리거의
//   등록/비활성화/키 재발급 UI. [B1] 패널 수명은 워크플로 신원에 묶인다(쉘 key 마운트 +
//   수명 토큰): 신원 변경/언마운트 이후 도착하는 지연 GET/POST/DELETE/클립보드 완료는 폐기되고
//   시크릿/상태/복사/오류 상태는 초기화된다. [상태 게이트] 알 수 없는 상태(로딩, 오류)
//   에서는 변이 버튼을 렌더하지 않는다 — 알 수 없는 상태의 POST 는 기존 키를 회전시킨다(서버
//   upsert 계약). 정상 응답의 last4:null이면 미구성으로 등록을 허용한다. [B2] 표시 URL 은 실제 공개
//   진입점 POST /api/webhooks/workflows/:workflowId 다. 시크릿 전체값은 등록/재발급 응답에서
//   정확히 1회만 표시된다. 로드/액션 실패는 조용히 무시하지 않고 표면화한다.
// [authority] 표시 전용 컴포넌트 — 실행 권위 없음(규칙 8/9). 서명 규격 표시는 문서이지 실행
//   경로가 아니다. 응답 산문은 권위가 아니며 미구성 여부는 정상 응답의 last4로 구분한다.
import { useCallback, useEffect, useRef, useState, type JSX } from "react";
import {
  createLifecycleGuard,
  deriveWebhookPanelState,
  disableWorkflowWebhook,
  enableWorkflowWebhook,
  fetchWorkflowWebhookStatus,
  webhookDeliveryUrl,
  WebhookApiError,
  type WebhookPanelStatus,
} from "./workflow-webhook-api.js";
import { buttonStyle, dangerButtonStyle, mutedTextStyle, noticeStyle } from "./workflow-page-styles.js";

const panelStyle = {
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  padding: "12px",
  display: "grid",
  gap: "8px",
  background: "var(--background, #020617)",
} as const;

const secretBoxStyle = {
  border: "1px solid #f59e0b",
  borderRadius: "6px",
  padding: "10px",
  display: "grid",
  gap: "6px",
  background: "color-mix(in srgb, #f59e0b 8%, transparent)",
} as const;

const hintStyle = {
  ...mutedTextStyle,
  fontSize: "11px",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  whiteSpace: "pre-wrap" as const,
};

type OnceSecret = { secret: string; last4: string };

export function WorkflowWebhookPanel({ workflowId }: { workflowId: string }): JSX.Element {
  const [status, setStatus] = useState<WebhookPanelStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [errorStatus, setErrorStatus] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [onceSecret, setOnceSecret] = useState<OnceSecret | null>(null);
  const [copied, setCopied] = useState(false);
  // [three-fixes F1] 액션 실패는 로드 오류와 별도 상태다 — status 유래 phase 를 오염시키지 않는다.
  const [actionError, setActionError] = useState<string | null>(null);
  // [three-fixes F3] 시크릿 세대 — 이전 세대의 지연 클립보드 완료가 현재 표시를 바꾸지 못한다.
  const secretGenerationRef = useRef(0);
  // [B1] 수명 토큰 — 이 마운트/신원 이후에 도착하는 비동기 완료를 폐기한다.
  const guardRef = useRef(createLifecycleGuard());

  const refresh = useCallback(async (guard = guardRef.current): Promise<void> => {
    // [three-fixes F2] 수명은 fetch "이전"에 검사한다 — 죽은 수명의 refresh 는 아무 것도 하지 않는다.
    if (!workflowId.trim() || !guard.alive) return;
    setLoading(true);
    setError(null);
    setErrorStatus(null);
    const settled = await guard.run(async () => {
      try {
        return { status: await fetchWorkflowWebhookStatus(workflowId), error: null as string | null, errorStatus: null as number | null };
      } catch (err) {
        return {
          status: null,
          error: err instanceof Error ? err.message : String(err),
          errorStatus: err instanceof WebhookApiError ? err.status : null,
        };
      }
    });
    if (settled === null) return; // 수명 종료(신원 변경/언마운트) — 폐기된 완료는 적용하지 않는다.
    setLoading(false);
    setStatus(settled.status);
    setError(settled.error);
    setErrorStatus(settled.errorStatus);
  }, [workflowId]);

  useEffect(() => {
    // [B1][three-fixes F2] 신원 변경 시 이전 수명을 끝내고 신원 소유 상태(busy/status/오류/시크릿/
    // 복사/세대)를 일관되게 전부 초기화한다 — 같은 인스턴스의 무 key 사용 예에도 안전하다.
    guardRef.current.end();
    guardRef.current = createLifecycleGuard();
    setOnceSecret(null);
    setCopied(false);
    setBusy(false);
    setStatus(null);
    setError(null);
    setErrorStatus(null);
    setActionError(null);
    setLoading(true);
    secretGenerationRef.current += 1;
    void refresh(guardRef.current);
    return () => { guardRef.current.end(); };
  }, [refresh]);

  async function runAction(action: (opGuard: ReturnType<typeof createLifecycleGuard>) => Promise<void>): Promise<void> {
    // [three-fixes F2] 연산 수명을 await "이전"에 캡처한다 — 이후 guardRef 가 교체되어도 이 연산의
    // 권위는 캡처된 수명이며, 교체된 가드를 구 수명의 권위로 읽지 않는다.
    const opGuard = guardRef.current;
    setBusy(true);
    setActionError(null);
    try {
      await action(opGuard);
    } catch (err) {
      // [three-fixes F1] 실패는 현재 수명에서만 가시화된다 — 미처리 거절/조용한 실패 모두 금지.
      if (opGuard.alive) {
        setActionError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      // [three-fixes F1] busy 는 성공/실패 무관하게 "현재 수명"에서 항상 정산된다.
      if (opGuard.alive) setBusy(false);
    }
  }

  /** [three-fixes F2] 후속 GET 은 연산 수명이 살아있을 때만 실행/적용된다. */
  async function refreshIfCurrent(opGuard: ReturnType<typeof createLifecycleGuard>): Promise<void> {
    if (!opGuard.alive) return;
    await refresh(opGuard);
  }

  function register(): void {
    void runAction(async (opGuard) => {
      const response = await enableWorkflowWebhook(workflowId);
      if (!opGuard.alive) return; // [three-fixes F2] setter "전" 수명 검사 — stale 성공은 무변경.
      secretGenerationRef.current += 1;
      setOnceSecret({ secret: response.secret, last4: response.last4 });
      setCopied(false);
      await refreshIfCurrent(opGuard);
    });
  }

  function rotate(): void {
    if (!window.confirm("키를 재발급할까요? 이전 키는 24시간까지만 유효합니다.")) return;
    void runAction(async (opGuard) => {
      const response = await enableWorkflowWebhook(workflowId);
      if (!opGuard.alive) return;
      secretGenerationRef.current += 1;
      setOnceSecret({ secret: response.secret, last4: response.last4 });
      setCopied(false);
      await refreshIfCurrent(opGuard);
    });
  }

  function disable(): void {
    if (!window.confirm("웹훅을 비활성화할까요? 외부 서명 호출이 더 이상 이 워크플로를 시작하지 않습니다.")) return;
    void runAction(async (opGuard) => {
      await disableWorkflowWebhook(workflowId);
      if (!opGuard.alive) return;
      secretGenerationRef.current += 1;
      setOnceSecret(null);
      setCopied(false);
      await refreshIfCurrent(opGuard);
    });
  }

  function copySecret(): void {
    if (!onceSecret) return;
    // [three-fixes F3] 대조 참조가 아니라 "세대 + 수명"을 캡처한다 — 닫힌 onceSecret 비교는
    // 같은 렌더 클로저라 회전 후에도 항상 참이므로 교체 키를 copied 로 표시할 수 있다.
    const generationAtCall = secretGenerationRef.current;
    const secretAtCall = onceSecret.secret;
    const isCurrentFeedback = () =>
      guardRef.current.alive && secretGenerationRef.current === generationAtCall;
    void (async () => {
      try {
        await navigator.clipboard.writeText(secretAtCall);
        if (isCurrentFeedback()) setCopied(true);
      } catch {
        if (isCurrentFeedback()) setCopied(false);
      }
    })();
  }

  const view = deriveWebhookPanelState({ loading, error, errorStatus, status });
  const phase = view.phase;
  const canMutate = phase === "unconfigured" || phase === "disabled" || phase === "enabled";

  return (
    <section style={panelStyle} aria-label="Workflow webhook management">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px", flexWrap: "wrap" }}>
        <span style={{ fontSize: "12px", fontWeight: 700, color: "var(--muted-foreground, #94a3b8)" }}>
          Webhook (외부 호출)
        </span>
        {phase === "enabled" ? (
          <span style={{ display: "flex", gap: "6px" }}>
            <button type="button" style={busy ? { ...buttonStyle, opacity: 0.6 } : buttonStyle} disabled={busy} onClick={rotate}>
              키 재발급
            </button>
            <button type="button" style={busy ? { ...dangerButtonStyle, opacity: 0.6 } : dangerButtonStyle} disabled={busy} onClick={disable}>
              비활성화
            </button>
          </span>
        ) : (phase === "unconfigured" || phase === "disabled") && canMutate ? (
          <button type="button" style={busy ? { ...buttonStyle, opacity: 0.6 } : buttonStyle} disabled={busy} onClick={register}>
            웹훅 등록
          </button>
        ) : null}
      </div>
      {phase === "loading" ? (
        <p style={{ ...mutedTextStyle, margin: 0, fontSize: "12px" }}>웹훅 상태를 불러오는 중...</p>
      ) : phase === "load-error" ? (
        <p style={{ ...noticeStyle("error"), margin: 0, fontSize: "12px" }}>웹훅 상태 로드 실패: {view.message}</p>
      ) : phase === "unconfigured" ? (
        <p style={{ ...mutedTextStyle, margin: 0, fontSize: "12px" }}>
          외부에서 서명된 호출로 이 워크플로를 시작할 수 있습니다. 등록하면 서명 비밀키가 한 번 발급됩니다.
        </p>
      ) : phase === "disabled" ? (
        <p style={{ ...mutedTextStyle, margin: 0, fontSize: "12px" }}>
          비활성 상태 — 키 끝 4자 <code>****{view.status.last4}</code>. 등록하면 새 비밀키가 발급되고 다시 활성화됩니다.
        </p>
      ) : (
        <p style={{ ...mutedTextStyle, margin: 0, fontSize: "12px" }}>
          활성 — 키 끝 4자 <code>****{view.status.last4}</code> · 최근 24시간 수신 {view.status.deliveriesLast24h}건
        </p>
      )}
      {actionError ? (
        <p style={{ ...noticeStyle("error"), margin: 0, fontSize: "12px" }}>웹훅 작업 실패: {actionError}</p>
      ) : null}
      {onceSecret ? (
        <div style={secretBoxStyle}>
          <strong style={{ fontSize: "12px" }}>서명 비밀키 (끝 4자 {onceSecret.last4})</strong>
          <code style={{ fontSize: "12px", wordBreak: "break-all" }}>{onceSecret.secret}</code>
          <span style={{ ...mutedTextStyle, fontSize: "11px" }}>이 비밀키는 다시 표시되지 않습니다.</span>
          <div style={{ display: "flex", gap: "6px", alignItems: "center" }}>
            <button type="button" style={{ ...buttonStyle, padding: "4px 8px", fontSize: "11px" }} onClick={() => { void copySecret(); }}>
              {copied ? "복사됨" : "복사"}
            </button>
          </div>
          <pre style={{ ...hintStyle, margin: 0 }}>{`curl -X POST ${webhookDeliveryUrl(workflowId)} \\
  -H "X-Timestamp: <unix-seconds>" \\
  -H "X-Idempotency-Key: <uuid>" \\
  -H "X-Signature: hex(HMAC-SHA256(secret, \\\`\${timestamp}.\${body}\\\`))" \\
  -H "content-type: application/json" -d '{...}'`}</pre>
        </div>
      ) : null}
    </section>
  );
}
