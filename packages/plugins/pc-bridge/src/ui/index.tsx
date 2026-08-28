import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useState,
} from "react";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";

type WorkflowOption = {
  workflow: string;
  category: string;
};

type PublishHistoryEntry = {
  id: string;
  requestedAt: string;
  source: string;
  url: string;
  workflow: string | null;
  category: string | null;
  ok: boolean;
  httpStatus: number | null;
  permalink: string | null;
  title: string | null;
  imageCount: number | null;
  error: string | null;
  message: string | null;
  durationMs: number;
};

type StatusSnapshot = {
  generatedAt: string;
  config: {
    bridgeBaseUrl: string;
    webhookKeyRef: string;
    webhookKeyConfigured: boolean;
    requestTimeoutMs: number;
    historyLimit: number;
  };
  health: {
    checkedAt: string;
    baseUrl: string;
    reachable: boolean;
    healthy: boolean;
    httpStatus: number | null;
    detail: string;
  };
  workflows: WorkflowOption[];
  history: PublishHistoryEntry[];
};

type PublishActionOutcome = {
  entry?: PublishHistoryEntry;
  result?: {
    ok: boolean;
    httpStatus: number | null;
    body: Record<string, unknown> | null;
    error: string | null;
  };
  error?: string;
};

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  padding: "14px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "#e5e7eb",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "12px",
  borderRadius: "10px",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  background: "rgba(255, 255, 255, 0.04)",
};

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: "12px",
  color: "#9ca3af",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "12px",
};

const thStyle: CSSProperties = {
  textAlign: "left",
  fontSize: "11px",
  letterSpacing: "0.04em",
  textTransform: "uppercase",
  color: "#9ca3af",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.12)",
};

const tdStyle: CSSProperties = {
  verticalAlign: "top",
  padding: "8px 10px",
  borderBottom: "1px solid rgba(255, 255, 255, 0.08)",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid rgba(255, 255, 255, 0.16)",
  borderRadius: "8px",
  fontSize: "13px",
  background: "rgba(17, 24, 39, 0.9)",
  color: "#f9fafb",
};

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid #111827",
  borderRadius: "8px",
  background: "#111827",
  color: "#ffffff",
  cursor: "pointer",
  fontSize: "13px",
  fontWeight: 600,
};

function badgeStyle(ok: boolean): CSSProperties {
  return {
    display: "inline-flex",
    alignItems: "center",
    gap: "4px",
    borderRadius: "999px",
    padding: "2px 8px",
    background: ok ? "#dcfce7" : "#fee2e2",
    color: ok ? "#166534" : "#991b1b",
    fontSize: "11px",
    fontWeight: 700,
  };
}

function formatDateTime(value: string | undefined): string {
  if (!value) {
    return "-";
  }

  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "medium",
  }).format(parsed);
}

function DataError({ error }: { error: unknown }): JSX.Element | null {
  if (!error) {
    return null;
  }

  return <p style={{ ...mutedStyle, color: "#b91c1c" }}>{(error as Error)?.message ?? String(error)}</p>;
}

function HealthSection({ snapshot }: { snapshot: StatusSnapshot }): JSX.Element {
  const health = snapshot.health;

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
        <strong style={{ fontSize: "14px" }}>맥 브리지 상태</strong>
        <span style={badgeStyle(health.healthy)}>
          {health.healthy ? "정상" : health.reachable ? "응답 이상" : "연결 불가"}
        </span>
      </div>
      <p style={mutedStyle}>
        {snapshot.config.bridgeBaseUrl} · HTTP {health.httpStatus ?? "-"} · {formatDateTime(health.checkedAt)}
      </p>
      <p style={mutedStyle}>{health.detail}</p>
      <p style={mutedStyle}>
        웹훅 키: {snapshot.config.webhookKeyConfigured
          ? `설정됨${snapshot.config.webhookKeyRef ? ` (시크릿 참조: ${snapshot.config.webhookKeyRef})` : " (인라인)"}`
          : "미설정 — 발행 불가"}
      </p>
    </section>
  );
}

function PublishForm({
  workflows,
  onSubmit,
}: {
  workflows: WorkflowOption[];
  onSubmit: (values: { url: string; workflow: string | null; category: string | null }) => Promise<PublishActionOutcome>;
}): JSX.Element {
  const [url, setUrl] = useState("");
  const [mode, setMode] = useState<"workflow" | "category">("workflow");
  const [workflow, setWorkflow] = useState(workflows[0]?.workflow ?? "");
  const [category, setCategory] = useState(workflows[0]?.category ?? "");
  const [busy, setBusy] = useState(false);
  const [resultMessage, setResultMessage] = useState("");
  const [isError, setIsError] = useState(false);

  async function handleSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setResultMessage("");
    setIsError(false);

    try {
      const outcome = await onSubmit({
        url,
        workflow: mode === "workflow" ? workflow : null,
        category: mode === "category" ? category : null,
      });

      if ("error" in outcome && outcome.error) {
        setIsError(true);
        setResultMessage(outcome.error);
        return;
      }

      if (outcome.result && outcome.result.ok) {
        const entry = outcome.entry;
        const lines = [
          `발행 완료: ${entry?.title ?? "(제목 없음)"}`,
          `카테고리: ${entry?.category ?? "-"}`,
          entry?.permalink ? `퍼머링크: ${entry.permalink}` : "",
          typeof entry?.imageCount === "number" ? `이미지 수: ${entry.imageCount}` : "",
        ].filter(Boolean);
        setResultMessage(lines.join(" · "));
        setUrl("");
        return;
      }

      setIsError(true);
      setResultMessage(outcome.error ?? "발행이 실패했습니다.");
    } catch (error) {
      setIsError(true);
      setResultMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section style={cardStyle}>
      <strong style={{ fontSize: "14px" }}>수동 발행</strong>
      <p style={mutedStyle}>
        허용 호스트(https)의 URL과 워크플로우/카테고리를 선택해 맥 브리지로 발행을 지시합니다.
      </p>
      <form onSubmit={(event) => void handleSubmit(event)} style={{ display: "grid", gap: "10px" }}>
        <label style={{ display: "grid", gap: "6px" }}>
          <span style={mutedStyle}>콘텐츠 URL (https)</span>
          <input
            required
            style={inputStyle}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            placeholder="https://manual-onboarding.pages.dev/..."
          />
        </label>

        <div style={{ display: "flex", gap: "12px", alignItems: "center" }}>
          <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <input
              type="radio"
              name="pc-bridge-mode"
              checked={mode === "workflow"}
              onChange={() => setMode("workflow")}
            />
            <span style={mutedStyle}>워크플로우</span>
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "6px" }}>
            <input
              type="radio"
              name="pc-bridge-mode"
              checked={mode === "category"}
              onChange={() => setMode("category")}
            />
            <span style={mutedStyle}>카테고리 직접 지정</span>
          </label>
        </div>

        {mode === "workflow" ? (
          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>워크플로우</span>
            <select
              style={inputStyle}
              value={workflow}
              onChange={(event) => setWorkflow(event.target.value)}
            >
              {workflows.map((option) => (
                <option key={option.workflow} value={option.workflow}>
                  {option.workflow} ({option.category})
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>카테고리</span>
            <select
              style={inputStyle}
              value={category}
              onChange={(event) => setCategory(event.target.value)}
            >
              {[...new Set(workflows.map((option) => option.category))].map((item) => (
                <option key={item} value={item}>{item}</option>
              ))}
            </select>
          </label>
        )}

        {resultMessage ? (
          <p style={{ ...mutedStyle, color: isError ? "#b91c1c" : "#166534" }}>{resultMessage}</p>
        ) : null}

        <div>
          <button type="submit" style={buttonStyle} disabled={busy}>
            {busy ? "발행 지시 중..." : "발행 지시"}
          </button>
        </div>
      </form>
    </section>
  );
}

function HistorySection({ history }: { history: PublishHistoryEntry[] }): JSX.Element {
  return (
    <section style={cardStyle}>
      <strong style={{ fontSize: "14px" }}>최근 발행 이력</strong>
      {history.length === 0 ? (
        <p style={mutedStyle}>아직 발행 이력이 없습니다.</p>
      ) : (
        <table style={tableStyle}>
          <thead>
            <tr>
              <th style={thStyle}>시각</th>
              <th style={thStyle}>출처</th>
              <th style={thStyle}>대상</th>
              <th style={thStyle}>결과</th>
            </tr>
          </thead>
          <tbody>
            {history.map((entry) => (
              <tr key={entry.id}>
                <td style={tdStyle}>{formatDateTime(entry.requestedAt)}</td>
                <td style={tdStyle}>{entry.source}</td>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "3px" }}>
                    <span style={{ wordBreak: "break-all" }}>{entry.url}</span>
                    <span style={mutedStyle}>
                      {entry.workflow ? `${entry.workflow} → ` : ""}{entry.category ?? "-"}
                    </span>
                  </div>
                </td>
                <td style={tdStyle}>
                  <div style={{ display: "grid", gap: "4px" }}>
                    <span style={badgeStyle(entry.ok)}>{entry.ok ? "성공" : "실패"}</span>
                    {entry.permalink ? (
                      <a href={entry.permalink} target="_blank" rel="noopener" style={{ ...mutedStyle, wordBreak: "break-all" }}>
                        {entry.permalink}
                      </a>
                    ) : null}
                    {entry.title ? <span style={mutedStyle}>{entry.title}</span> : null}
                    {typeof entry.imageCount === "number" ? (
                      <span style={mutedStyle}>이미지 {entry.imageCount}장</span>
                    ) : null}
                    {entry.error ? <span style={{ ...mutedStyle, color: "#b91c1c" }}>{entry.error}</span> : null}
                    {entry.message && !entry.error ? <span style={mutedStyle}>{entry.message}</span> : null}
                    <span style={mutedStyle}>{Math.round(entry.durationMs / 100) / 10}s</span>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function PcBridgePage(_props: PluginPageProps): JSX.Element {
  const snapshot = usePluginData<StatusSnapshot>(DATA_KEYS.status, {});
  const publish = usePluginAction(ACTION_KEYS.publish);

  async function handlePublish(values: { url: string; workflow: string | null; category: string | null }): Promise<PublishActionOutcome> {
    const outcome = await publish({
      url: values.url,
      workflow: values.workflow ?? undefined,
      category: values.category ?? undefined,
    });
    await snapshot.refresh();
    return outcome as PublishActionOutcome;
  }

  return (
    <div style={pageStyle}>
      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
          <strong style={{ fontSize: "14px" }}>PC Bridge (네이버 발행 지시)</strong>
          <button type="button" style={buttonStyle} onClick={snapshot.refresh}>
            새로고침
          </button>
        </div>
        <DataError error={snapshot.error} />
        {snapshot.loading ? <p style={mutedStyle}>상태를 불러오는 중...</p> : null}
      </section>

      {snapshot.data ? <HealthSection snapshot={snapshot.data} /> : null}

      <PublishForm workflows={snapshot.data?.workflows ?? []} onSubmit={handlePublish} />

      <HistorySection history={snapshot.data?.history ?? []} />

      <section style={cardStyle}>
        <strong style={{ fontSize: "14px" }}>A1에서 호출하기</strong>
        <p style={mutedStyle}>
          에이전트 툴 <code>pc-bridge-publish</code> (파라미터 url + workflow 또는 category) 또는 웹훅{" "}
          <code>POST /api/plugins/pc-bridge/webhooks/publish</code>{" "}
          (헤더 <code>X-Papercompany-Webhook-Key</code>, JSON 본문)로 발행을 지시할 수 있습니다.
        </p>
      </section>
    </div>
  );
}

export function PcBridgeSidebarLink({ context }: { context?: { companyPrefix?: string | null } }): JSX.Element {
  const host = useHostContext();
  const prefix = host.companyPrefix ?? context?.companyPrefix ?? "";
  const href = prefix ? `/${prefix}/pc-bridge` : "/pc-bridge";
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
      href={href}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "10px",
        padding: "8px 12px",
        fontSize: "13px",
        fontWeight: 500,
        textDecoration: "none",
        color: isActive ? "var(--foreground, #f8fafc)" : "color-mix(in srgb, var(--foreground, #f8fafc) 80%, transparent)",
        background: isActive ? "var(--accent, rgba(125,211,252,0.12))" : "transparent",
        borderRadius: "8px",
      }}
    >
      <span>🖥️ PC Bridge</span>
    </a>
  );
}
