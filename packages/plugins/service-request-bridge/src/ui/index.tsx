import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useMemo,
  useState,
} from "react";
import {
  ACTION_KEYS,
  BRIDGE_DIRECTIONS,
  DATA_KEYS,
  PLUGIN_ID,
} from "../constants.js";

type GenericIssueTabProps = {
  context?: {
    companyId?: string | null;
    companyPrefix?: string | null;
  };
  issueId?: string;
  selectedIssueId?: string;
  issue?: {
    id?: string;
    identifier?: string | null;
    title?: string;
    status?: string;
  };
  issues?: Array<{
    id?: string;
    identifier?: string | null;
  }>;
  issueIds?: string[];
};

type ListTabSnapshot = {
  companyId: string;
  generatedAt: string;
  totals: {
    issues: number;
    linked: number;
    unlinked: number;
  };
  items: Array<{
    issueId: string;
    identifier: string | null;
    title: string;
    status: string;
    linkCount: number;
    links: Array<{
      bridgeId: string;
      direction: string;
      remoteCompanyId: string;
      remoteCompanyName: string | null;
      remoteIssueId: string;
      remoteIdentifier: string | null;
      remoteTitle: string | null;
      remoteStatus: string | null;
    }>;
  }>;
};

type DetailTabSnapshot = {
  companyId: string;
  generatedAt: string;
  issue: {
    id: string;
    identifier: string | null;
    title: string;
    status: string;
  } | null;
  links: Array<{
    bridgeId: string;
    direction: string;
    remoteCompanyId: string;
    remoteCompanyName: string | null;
    remoteIssueId: string;
    remoteIdentifier: string | null;
    remoteTitle: string | null;
    remoteStatus: string | null;
    updatedAt: string;
    lastSyncedAt?: string;
    lastSyncedStatus?: string;
  }>;
  remoteCompanies: Array<{ id: string; name: string }>;
};

type DashboardWidgetSnapshot = {
  companyId: string;
  generatedAt: string;
  totalActiveLinks: number;
  statusCounts: {
    open: number;
    inProgress: number;
    resolved: number;
    unknown: number;
  };
};

const tabStyle: CSSProperties = {
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

const widgetStyle: CSSProperties = {
  display: "grid",
  gap: "10px",
  padding: "12px",
  border: "1px solid rgba(255, 255, 255, 0.12)",
  borderRadius: "12px",
  background: "rgba(255, 255, 255, 0.04)",
  color: "#e5e7eb",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
};

function statusBadgeStyle(connected: boolean): CSSProperties {
  return connected
    ? {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        borderRadius: "999px",
        padding: "2px 8px",
        background: "#dcfce7",
        color: "#166534",
        fontSize: "11px",
        fontWeight: 700,
      }
    : {
        display: "inline-flex",
        alignItems: "center",
        gap: "4px",
        borderRadius: "999px",
        padding: "2px 8px",
        background: "rgba(255, 255, 255, 0.08)",
        color: "#d1d5db",
        fontSize: "11px",
        fontWeight: 700,
      };
}

function directionLabel(direction: string): string {
  if (direction === BRIDGE_DIRECTIONS.localToRemote) {
    return "local -> remote";
  }
  if (direction === BRIDGE_DIRECTIONS.remoteToLocal) {
    return "remote -> local";
  }
  return "two-way";
}

function settingsHref(companyPrefix?: string | null): string {
  return companyPrefix ? `/${companyPrefix}/bridge-settings` : "/bridge-settings";
}

function bridgeHref(companyPrefix?: string | null): string {
  return companyPrefix ? `/${companyPrefix}/service-request-bridge` : "/service-request-bridge";
}

function resolveIssueId(props: GenericIssueTabProps): string {
  return props.issueId ?? props.selectedIssueId ?? props.issue?.id ?? "";
}

function resolveIssueIds(props: GenericIssueTabProps): string[] {
  if (Array.isArray(props.issueIds) && props.issueIds.length > 0) {
    return props.issueIds.filter((item) => typeof item === "string" && item.trim().length > 0);
  }

  if (Array.isArray(props.issues) && props.issues.length > 0) {
    return props.issues
      .map((item) => item.id ?? item.identifier ?? "")
      .filter((item) => typeof item === "string" && item.trim().length > 0) as string[];
  }

  return [];
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
    timeStyle: "short",
  }).format(parsed);
}

function DataError({ error }: { error: unknown }): JSX.Element | null {
  if (!error) {
    return null;
  }

  return <p style={{ ...mutedStyle, color: "#b91c1c" }}>{(error as Error)?.message ?? String(error)}</p>;
}

function BridgeHelpSection(): JSX.Element {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <strong style={{ fontSize: "14px" }}>Help</strong>
        <button type="button" style={buttonStyle} onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? "닫기" : "도움말"}
        </button>
      </div>
      {showHelp && (
        <div style={mutedStyle}>
          <p style={{ ...mutedStyle, fontWeight: 600, fontSize: "14px", marginBottom: "8px" }}>Service Request Bridge 도움말</p>

          <p style={{ ...mutedStyle, fontWeight: 600, marginTop: "12px" }}>기본 개념</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li><strong>Bridge Link</strong>: 두 회사 간 이슈를 연결하는 양방향 링크</li>
            <li><strong>Mirror Issue</strong>: 요청 이슈의 사본을 제공자 회사에 자동 생성</li>
            <li><strong>Sync</strong>: 한쪽 이슈 상태 변경 시 자동으로 반대쪽도 변경</li>
          </ul>

          <p style={{ ...mutedStyle, fontWeight: 600, marginTop: "12px" }}>설정</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li><strong>Provider Company</strong>: 서비스 제공 회사 이름</li>
            <li><strong>Requester Issue Label Aliases</strong>: 요청 이슈에 이 라벨 별칭 중 하나가 붙으면 자동 미러링</li>
            <li><strong>Requester Title Prefixes</strong>: 요청 이슈 제목이 이 prefix 중 하나로 시작해도 자동 미러링</li>
            <li><strong>Workflow Trigger Label</strong>: 미러 이슈에 붙일 워크플로우 트리거 라벨</li>
          </ul>

          <p style={{ ...mutedStyle, fontWeight: 600, marginTop: "12px" }}>방향 제어</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li><strong>two-way</strong>: 양방향 동기화</li>
            <li><strong>local-to-remote</strong>: 로컬 → 리모트만</li>
            <li><strong>remote-to-local</strong>: 리모트 → 로컬만</li>
          </ul>
        </div>
      )}
    </section>
  );
}

export function ServiceRequestBridgeListTab(props: GenericIssueTabProps): JSX.Element {
  const host = useHostContext();
  const companyId = host.companyId ?? props.context?.companyId ?? "";
  const companyPrefix = host.companyPrefix ?? props.context?.companyPrefix ?? "";
  const issueIds = useMemo(() => resolveIssueIds(props), [props.issueIds, props.issues]);

  const snapshot = usePluginData<ListTabSnapshot>(DATA_KEYS.listTab, {
    companyId,
    issueIds,
  });

  return (
    <div style={tabStyle}>
      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
          <strong style={{ fontSize: "14px" }}>Service Bridge 상태</strong>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <a href={settingsHref(companyPrefix)} style={{ ...buttonStyle, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              설정
            </a>
            <button type="button" style={buttonStyle} onClick={snapshot.refresh}>
              새로고침
            </button>
          </div>
        </div>
        <DataError error={snapshot.error} />
        {snapshot.loading ? <p style={mutedStyle}>연결 상태를 불러오는 중...</p> : null}
        {snapshot.data ? (
          <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
            <span style={statusBadgeStyle(true)}>linked {snapshot.data.totals.linked}</span>
            <span style={statusBadgeStyle(false)}>unlinked {snapshot.data.totals.unlinked}</span>
            <span style={{ ...mutedStyle, alignSelf: "center" }}>
              total {snapshot.data.totals.issues}
            </span>
          </div>
        ) : null}
      </section>

      {snapshot.data ? (
        <section style={cardStyle}>
          {snapshot.data.items.length === 0 ? (
            <p style={mutedStyle}>표시할 이슈가 없습니다.</p>
          ) : (
            <table style={tableStyle}>
              <thead>
                <tr>
                  <th style={thStyle}>Issue</th>
                  <th style={thStyle}>Status</th>
                  <th style={thStyle}>Bridge</th>
                  <th style={thStyle}>Remote</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.data.items.map((item) => (
                  <tr key={item.issueId}>
                    <td style={tdStyle}>
                      <div style={{ display: "grid", gap: "4px" }}>
                        <strong>{item.identifier ?? item.issueId.slice(0, 8)}</strong>
                        <span style={mutedStyle}>{item.title}</span>
                      </div>
                    </td>
                    <td style={tdStyle}>{item.status}</td>
                    <td style={tdStyle}>
                      <span style={statusBadgeStyle(item.linkCount > 0)}>
                        {item.linkCount > 0 ? "linked" : "unlinked"}
                      </span>
                    </td>
                    <td style={tdStyle}>
                      {item.links.length === 0 ? (
                        <span style={mutedStyle}>-</span>
                      ) : (
                        <div style={{ display: "grid", gap: "6px" }}>
                          {item.links.map((link) => (
                            <div key={link.bridgeId} style={{ display: "grid", gap: "2px" }}>
                              <strong style={{ fontSize: "12px" }}>
                                {link.remoteCompanyName ?? link.remoteCompanyId} / {link.remoteIdentifier ?? link.remoteIssueId}
                              </strong>
                              <span style={mutedStyle}>
                                {link.remoteStatus ?? "unknown"} · {directionLabel(link.direction)}
                              </span>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ) : null}

      <BridgeHelpSection />
    </div>
  );
}

export function ServiceRequestBridgeDetailTab(props: GenericIssueTabProps): JSX.Element {
  const host = useHostContext();
  const companyId = host.companyId ?? props.context?.companyId ?? "";
  const companyPrefix = host.companyPrefix ?? props.context?.companyPrefix ?? "";
  const issueId = resolveIssueId(props);

  const snapshot = usePluginData<DetailTabSnapshot>(DATA_KEYS.detailTab, {
    companyId,
    issueId,
  });

  const createLink = usePluginAction(ACTION_KEYS.createLink);

  const [remoteCompanyId, setRemoteCompanyId] = useState("");
  const [remoteIssueId, setRemoteIssueId] = useState("");
  const [direction, setDirection] = useState<string>(BRIDGE_DIRECTIONS.twoWay);
  const [editingBridgeId, setEditingBridgeId] = useState("");
  const [statusMessage, setStatusMessage] = useState("");
  const [errorMessage, setErrorMessage] = useState("");

  function loadLinkIntoForm(link: DetailTabSnapshot["links"][number]): void {
    setEditingBridgeId(link.bridgeId);
    setRemoteCompanyId(link.remoteCompanyId);
    setRemoteIssueId(link.remoteIdentifier ?? link.remoteIssueId);
    setDirection(link.direction);
    setStatusMessage("");
    setErrorMessage("");
  }

  function resetForm(): void {
    setEditingBridgeId("");
    setRemoteCompanyId("");
    setRemoteIssueId("");
    setDirection(BRIDGE_DIRECTIONS.twoWay);
  }

  async function onCreateLink(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setStatusMessage("");
    setErrorMessage("");

    try {
      if (!issueId) {
        throw new Error("Issue id is required");
      }

      await createLink({
        companyId,
        localIssueId: issueId,
        remoteCompanyId,
        remoteIssueId,
        direction,
        createdBy: "service-request-bridge-ui",
      });

      setStatusMessage(editingBridgeId ? "Bridge link updated." : "Bridge link saved.");
      resetForm();
      await snapshot.refresh();
    } catch (error) {
      setErrorMessage(error instanceof Error ? (error as Error)?.message ?? String(error) : String(error));
    }
  }

  return (
    <div style={tabStyle}>
      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
          <strong style={{ fontSize: "14px" }}>연결된 상대 회사 이슈</strong>
          <div style={{ display: "flex", gap: "8px", alignItems: "center" }}>
            <a href={settingsHref(companyPrefix)} style={{ ...buttonStyle, textDecoration: "none", display: "inline-flex", alignItems: "center" }}>
              설정
            </a>
            <button type="button" style={buttonStyle} onClick={snapshot.refresh}>
              새로고침
            </button>
          </div>
        </div>

        {snapshot.loading ? <p style={mutedStyle}>연결 정보를 불러오는 중...</p> : null}
        <DataError error={snapshot.error} />

        {snapshot.data?.issue ? (
          <p style={mutedStyle}>
            local issue: {snapshot.data.issue.identifier ?? snapshot.data.issue.id} ({snapshot.data.issue.status})
          </p>
        ) : (
          <p style={mutedStyle}>현재 이슈 컨텍스트를 찾지 못했습니다.</p>
        )}

        {statusMessage ? <p style={{ ...mutedStyle, color: "#166534" }}>{statusMessage}</p> : null}
        {errorMessage ? <p style={{ ...mutedStyle, color: "#b91c1c" }}>{errorMessage}</p> : null}

        {snapshot.data?.links && snapshot.data.links.length > 0 ? (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Remote</th>
                <th style={thStyle}>Status</th>
                <th style={thStyle}>Direction</th>
                <th style={thStyle}>Synced</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.data.links.map((link) => (
                <tr key={link.bridgeId}>
                  <td style={tdStyle}>
                    <div style={{ display: "grid", gap: "3px" }}>
                      <strong>{link.remoteCompanyName ?? link.remoteCompanyId}</strong>
                      <span style={mutedStyle}>{link.remoteIdentifier ?? link.remoteIssueId}</span>
                      {link.remoteTitle ? <span style={mutedStyle}>{link.remoteTitle}</span> : null}
                    </div>
                  </td>
                  <td style={tdStyle}>{link.remoteStatus ?? "unknown"}</td>
                  <td style={tdStyle}>{directionLabel(link.direction)}</td>
                  <td style={tdStyle}>
                    <div style={{ display: "grid", gap: "8px" }}>
                      <span>{formatDateTime(link.lastSyncedAt ?? link.updatedAt)}</span>
                      <button
                        type="button"
                        style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }}
                        onClick={() => loadLinkIntoForm(link)}
                      >
                        수정
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p style={mutedStyle}>연결된 브리지가 아직 없습니다.</p>
        )}
      </section>

      <section style={cardStyle}>
        <div style={{ display: "flex", justifyContent: "space-between", gap: "12px", alignItems: "center" }}>
          <strong style={{ fontSize: "14px" }}>{editingBridgeId ? "Bridge 연결 수정" : "Bridge 연결 생성"}</strong>
          {editingBridgeId ? (
            <button type="button" style={{ ...buttonStyle, padding: "6px 10px", fontSize: "12px" }} onClick={resetForm}>
              취소
            </button>
          ) : null}
        </div>
        <p style={mutedStyle}>
          설정은 별도 설정 페이지에서 관리합니다. 기존 링크는 불러와서 방향을 수정할 수 있습니다.
        </p>
        <form onSubmit={(event) => void onCreateLink(event)} style={{ display: "grid", gap: "10px" }}>
          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>Remote company</span>
            <select
              required
              style={inputStyle}
              value={remoteCompanyId}
              onChange={(event) => setRemoteCompanyId(event.target.value)}
            >
              <option value="">Choose company</option>
              {(snapshot.data?.remoteCompanies ?? []).map((company) => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>Remote issue id or identifier</span>
            <input
              required
              style={inputStyle}
              value={remoteIssueId}
              onChange={(event) => setRemoteIssueId(event.target.value)}
              placeholder="e.g. issue id"
            />
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>Direction</span>
            <select
              style={inputStyle}
              value={direction}
              onChange={(event) => setDirection(event.target.value)}
            >
              <option value={BRIDGE_DIRECTIONS.twoWay}>two-way</option>
              <option value={BRIDGE_DIRECTIONS.localToRemote}>local -&gt; remote</option>
              <option value={BRIDGE_DIRECTIONS.remoteToLocal}>remote -&gt; local</option>
            </select>
          </label>

          <div>
            <button type="submit" style={buttonStyle}>{editingBridgeId ? "Bridge 수정 저장" : "Bridge 저장"}</button>
          </div>
        </form>
      </section>
    </div>
  );
}

export function BridgeDashboardWidget({ context }: PluginWidgetProps): JSX.Element {
  const snapshot = usePluginData<DashboardWidgetSnapshot>(DATA_KEYS.dashboardWidget, {
    companyId: context.companyId ?? "",
  });

  if (snapshot.loading) {
    return <div style={widgetStyle}>Bridge 위젯 로딩 중...</div>;
  }

  if (snapshot.error) {
    return <div style={widgetStyle}>Bridge 위젯 오류: {String(snapshot.error)}</div>;
  }

  if (!snapshot.data) {
    return <div style={widgetStyle}>Bridge 위젯 데이터가 없습니다.</div>;
  }

  return (
    <section style={widgetStyle}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: "8px" }}>
        <strong>Service Bridge</strong>
        <span style={{ ...mutedStyle, fontSize: "11px" }}>{formatDateTime(snapshot.data.generatedAt)}</span>
      </div>

      <div style={{ display: "grid", gap: "4px" }}>
        <div style={{ fontSize: "26px", fontWeight: 700, lineHeight: 1 }}>{snapshot.data.totalActiveLinks}</div>
        <div style={mutedStyle}>활성 링크 수</div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: "8px" }}>
        <span style={statusBadgeStyle(true)}>open {snapshot.data.statusCounts.open}</span>
        <span style={{ ...statusBadgeStyle(true), background: "#dbeafe", color: "#1d4ed8" }}>
          in_progress {snapshot.data.statusCounts.inProgress}
        </span>
        <span style={{ ...statusBadgeStyle(true), background: "#f3e8ff", color: "#6b21a8" }}>
          resolved {snapshot.data.statusCounts.resolved}
        </span>
      </div>
    </section>
  );
}

export function BridgeSettingsTab(): JSX.Element {
  const snapshot = usePluginData<{
    providerCompanyId: string;
    providerCompanyName: string;
    providerProjectId: string;
    providerProjectName: string;
    requesterLabelNames: string[];
    requesterTitlePrefixes: string[];
    requesterLabelName?: string;
    autoCreateMirrorIssue: boolean;
    workflowTriggerLabel: string;
    companies: Array<{ id: string; name: string; projects: Array<{ id: string; name: string }> }>;
    providerProjects: Array<{ id: string; name: string }>;
  }>(DATA_KEYS.settingsGet, {});

  const [providerCompanyId, setProviderCompanyId] = useState("");
  const [providerCompanyName, setProviderCompanyName] = useState("");
  const [providerProjectId, setProviderProjectId] = useState("");
  const [providerProjectName, setProviderProjectName] = useState("");
  const [requesterLabelNamesText, setRequesterLabelNamesText] = useState("");
  const [requesterTitlePrefixesText, setRequesterTitlePrefixesText] = useState("");
  const [autoCreateMirrorIssue, setAutoCreateMirrorIssue] = useState(true);
  const [workflowTriggerLabel, setWorkflowTriggerLabel] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  const companies = snapshot.data?.companies ?? [];
  const availableProjects = companies.find((company) => company.id === providerCompanyId)?.projects
    ?? snapshot.data?.providerProjects
    ?? [];

  function parseAliases(value: string): string[] {
    return [...new Set(value.split(",").map((item) => item.trim()).filter(Boolean))];
  }

  if (snapshot.data && !loaded) {
    setProviderCompanyId(snapshot.data.providerCompanyId || "");
    setProviderCompanyName(snapshot.data.providerCompanyName || "");
    setProviderProjectId(snapshot.data.providerProjectId || "");
    setProviderProjectName(snapshot.data.providerProjectName || "");
    setRequesterLabelNamesText(
      (snapshot.data.requesterLabelNames && snapshot.data.requesterLabelNames.length > 0
        ? snapshot.data.requesterLabelNames
        : snapshot.data.requesterLabelName
          ? [snapshot.data.requesterLabelName]
          : []
      ).join(", "),
    );
    setRequesterTitlePrefixesText(
      (snapshot.data.requesterTitlePrefixes && snapshot.data.requesterTitlePrefixes.length > 0
        ? snapshot.data.requesterTitlePrefixes
        : snapshot.data.requesterLabelName
          ? [snapshot.data.requesterLabelName]
          : []
      ).join(", "),
    );
    setAutoCreateMirrorIssue(snapshot.data.autoCreateMirrorIssue ?? true);
    setWorkflowTriggerLabel(snapshot.data.workflowTriggerLabel || "");
    setLoaded(true);
  }

  async function onSave(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setStatusMsg("");
    try {
      const selectedCompany = companies.find((company) => company.id === providerCompanyId);
      const selectedProject = availableProjects.find((project) => project.id === providerProjectId);
      const res = await fetch(`/api/plugins/${PLUGIN_ID}/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          configJson: {
            providerCompanyId,
            providerCompanyName: selectedCompany?.name ?? providerCompanyName,
            providerProjectId,
            providerProjectName: selectedProject?.name ?? providerProjectName,
            requesterLabelNames: parseAliases(requesterLabelNamesText),
            requesterTitlePrefixes: parseAliases(requesterTitlePrefixesText),
            autoCreateMirrorIssue,
            workflowTriggerLabel,
          },
        }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      setStatusMsg("설정이 저장되었습니다.");
    } catch (err) {
      setStatusMsg(`오류: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return (
    <div style={tabStyle}>
      <section style={cardStyle}>
        <strong style={{ fontSize: "14px" }}>Service Bridge 설정</strong>
        {snapshot.loading ? <p style={mutedStyle}>로딩 중...</p> : null}
        <DataError error={snapshot.error} />
        <form onSubmit={(e) => void onSave(e)} style={{ display: "grid", gap: "12px" }}>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={mutedStyle}>Provider Company (서비스 제공 회사)</span>
            <select
              style={inputStyle}
              value={providerCompanyId}
              onChange={(e) => {
                const nextId = e.target.value;
                const nextCompany = companies.find((company) => company.id === nextId);
                setProviderCompanyId(nextId);
                setProviderCompanyName(nextCompany?.name ?? "");
                setProviderProjectId("");
                setProviderProjectName("");
              }}
            >
              <option value="">(선택)</option>
              {companies.map((company) => (
                <option key={company.id} value={company.id}>{company.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={mutedStyle}>Provider Project (이슈를 생성할 프로젝트)</span>
            <select
              style={inputStyle}
              value={providerProjectId}
              onChange={(e) => {
                const nextId = e.target.value;
                const nextProject = availableProjects.find((project) => project.id === nextId);
                setProviderProjectId(nextId);
                setProviderProjectName(nextProject?.name ?? "");
              }}
              disabled={!providerCompanyId}
            >
              <option value="">(선택)</option>
              {availableProjects.map((project) => (
                <option key={project.id} value={project.id}>{project.name}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={mutedStyle}>Requester Issue Label Aliases (요청 이슈 라벨 별칭)</span>
            <input style={inputStyle} value={requesterLabelNamesText} onChange={(e) => setRequesterLabelNamesText(e.target.value)} placeholder="예: 유지보수, maintenance" />
          </label>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={mutedStyle}>Requester Title Prefixes (요청 이슈 제목 prefix)</span>
            <input style={inputStyle} value={requesterTitlePrefixesText} onChange={(e) => setRequesterTitlePrefixesText(e.target.value)} placeholder="예: 유지보수, maintenance" />
          </label>
          <label style={{ display: "grid", gap: "4px" }}>
            <span style={mutedStyle}>Workflow Trigger Label (미러 이슈에 붙일 라벨)</span>
            <input style={inputStyle} value={workflowTriggerLabel} onChange={(e) => setWorkflowTriggerLabel(e.target.value)} placeholder="(선택)" />
          </label>
          <label style={{ display: "flex", alignItems: "center", gap: "8px" }}>
            <input type="checkbox" checked={autoCreateMirrorIssue} onChange={(e) => setAutoCreateMirrorIssue(e.target.checked)} />
            <span style={mutedStyle}>Auto Create Mirror Issue</span>
          </label>
          {statusMsg ? <p style={{ ...mutedStyle, color: statusMsg.startsWith("오류") ? "#b91c1c" : "#166534" }}>{statusMsg}</p> : null}
          <div><button type="submit" style={buttonStyle}>저장</button></div>
        </form>
      </section>
    </div>
  );
}

export function BridgeSidebarLink({ context }: { context: { companyPrefix?: string | null } }) {
  const href = bridgeHref(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;
  return (
    <a
      href={href}
      style={{
        display: "flex", alignItems: "center", gap: "10px", padding: "8px 12px",
        fontSize: "13px", fontWeight: 500, textDecoration: "none",
        color: isActive ? "var(--foreground, #f8fafc)" : "color-mix(in srgb, var(--foreground, #f8fafc) 80%, transparent)",
        background: isActive ? "var(--accent, rgba(125,211,252,0.12))" : "transparent",
        borderRadius: "8px",
      }}
    >
      <span>🔗 Service Bridge</span>
    </a>
  );
}
