import {
  useHostContext,
  usePluginAction,
  usePluginData,
  usePluginToast,
  type PluginPageProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useMemo,
  useState,
} from "react";
import { ACTION_KEYS, DATA_KEYS } from "../constants.js";

// Fix: prevent parent window from capturing arrow keys in textareas
if (typeof window !== "undefined") {
  window.addEventListener("keydown", (e) => {
    const target = e.target as HTMLElement;
    if (target?.tagName === "TEXTAREA" && (e.key === "ArrowUp" || e.key === "ArrowDown")) {
      e.stopPropagation();
    }
  }, true);
}


type ToolConfig = {
  name: string;
  command: string;
  workingDirectory?: string;
  env?: Record<string, string>;
  requiresApproval: boolean;
  description?: string;
  instructions?: string;
  argsSchema?: Record<string, unknown>;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  __deleted?: boolean;
};

type ToolConfigRecord = {
  id: string;
  data: ToolConfig;
  createdAt: string;
  updatedAt: string;
};

type AgentToolGrantRecord = {
  id: string;
  data: {
    agentName: string;
    toolName: string;
    grantedBy: string;
    grantedAt: string;
  };
  createdAt: string;
  updatedAt: string;
};

type ExecutionLog = {
  timestamp: string;
  mode: "tool" | "denied" | "approval_required" | "audit";
  agentId: string;
  agentName: string;
  runId: string;
  companyId: string;
  projectId: string;
  toolName: string;
  command?: string;
  args?: unknown;
  exitCode?: number | null;
  stdout?: string;
  stderr?: string;
  success?: boolean;
  reason?: string;
};

type PageData = {
  companyId: string;
  companyName: string | null;
  tools: ToolConfigRecord[];
  grants: AgentToolGrantRecord[];
  logs: Array<{ id: string; createdAt: string; data: ExecutionLog }>;
  agents: Array<{ id: string; name: string; status: string; role: string }>;
};

type ToolFormState = {
  name: string;
  command: string;
  workingDirectory: string;
  description: string;
  instructions: string;
  requiresApproval: boolean;
};

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
  padding: "24px",
  fontFamily: "ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif",
  color: "var(--foreground, #f8fafc)",
};

const cardStyle: CSSProperties = {
  display: "grid",
  gap: "12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "12px",
  background: "var(--card, #0f172a)",
  padding: "16px",
};

const headerRowStyle: CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: "12px",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: "24px",
  lineHeight: 1.2,
  fontWeight: 700,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "16px",
  lineHeight: 1.3,
  fontWeight: 600,
};

const mutedTextStyle: CSSProperties = {
  margin: 0,
  fontSize: "13px",
  lineHeight: 1.4,
  color: "var(--muted-foreground, #94a3b8)",
};

const gridCols2Style: CSSProperties = {
  display: "grid",
  gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
  gap: "10px",
};

const inputStyle: CSSProperties = {
  width: "100%",
  padding: "8px 10px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  fontSize: "13px",
};

const buttonStyle: CSSProperties = {
  padding: "8px 12px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "8px",
  background: "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "13px",
};

const primaryButtonStyle: CSSProperties = {
  ...buttonStyle,
  background: "#111827",
  color: "#ffffff",
  borderColor: "var(--foreground, #f8fafc)",
};

const tableStyle: CSSProperties = {
  width: "100%",
  borderCollapse: "collapse",
  fontSize: "13px",
};

const thStyle: CSSProperties = {
  borderBottom: "1px solid var(--border, #334155)",
  textAlign: "left",
  padding: "8px 10px",
  fontSize: "11px",
  textTransform: "uppercase",
  color: "var(--muted-foreground, #94a3b8)",
  letterSpacing: "0.04em",
};

const tdStyle: CSSProperties = {
  borderBottom: "1px solid var(--border, #1e293b)",
  padding: "9px 10px",
  verticalAlign: "top",
};

const codeStyle: CSSProperties = {
  margin: 0,
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
  fontSize: "11px",
  lineHeight: 1.45,
  color: "#374151",
};

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

function truncate(value: string | undefined, max = 120): string {
  if (!value) {
    return "";
  }

  if (value.length <= max) {
    return value;
  }

  return `${value.slice(0, max)}…`;
}

type StatusFilter = "active" | "archived";

const filterTabStyle = (isActive: boolean): CSSProperties => ({
  padding: "6px 14px",
  border: "1px solid var(--border, #334155)",
  borderRadius: "6px",
  background: isActive
    ? "color-mix(in srgb, var(--foreground, #f8fafc) 14%, var(--card, #0f172a))"
    : "var(--card, #0f172a)",
  color: "var(--foreground, #f8fafc)",
  cursor: "pointer",
  fontSize: "12px",
  fontWeight: isActive ? 700 : 500,
  opacity: isActive ? 1 : 0.7,
});

function ToolSection({
  data,
  companyId,
  refresh,
}: {
  data: PageData;
  companyId: string;
  refresh: () => void;
}): JSX.Element {
  const toast = usePluginToast();
  const createToolAction = usePluginAction(ACTION_KEYS.createTool);
  const updateToolAction = usePluginAction(ACTION_KEYS.updateTool);
  const deleteToolAction = usePluginAction(ACTION_KEYS.deleteTool);
  const restoreToolAction = usePluginAction(ACTION_KEYS.restoreTool);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("active");

  const activeTools = useMemo(
    () => data.tools.filter((tool) => !tool.data.__deleted),
    [data.tools],
  );
  const archivedTools = useMemo(
    () => data.tools.filter((tool) => tool.data.__deleted === true),
    [data.tools],
  );
  const filteredTools = statusFilter === "active" ? activeTools : archivedTools;

  const [form, setForm] = useState<ToolFormState>({
    name: "",
    command: "",
    workingDirectory: "",
    description: "",
    instructions: "",
    requiresApproval: false,
  });

  async function onCreateTool(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    await createToolAction({
      companyId,
      tool: {
        name: form.name,
        command: form.command,
        workingDirectory: form.workingDirectory,
        description: form.description,
        instructions: form.instructions,
        requiresApproval: form.requiresApproval,
      },
      actorName: "tool-registry-ui",
    });

    toast({ title: `Tool created: ${form.name}`, tone: "success" });
    setForm({ name: "", command: "", workingDirectory: "", description: "", instructions: "", requiresApproval: false });
    refresh();
  }

  async function onToggleApproval(tool: ToolConfigRecord): Promise<void> {
    await updateToolAction({
      companyId,
      toolName: tool.data.name,
      patch: {
        requiresApproval: !tool.data.requiresApproval,
      },
    });

    toast({
      title: `${tool.data.name} approval ${tool.data.requiresApproval ? "disabled" : "enabled"}`,
      tone: "info",
    });
    refresh();
  }

  async function onDeleteTool(toolName: string): Promise<void> {
    await deleteToolAction({ companyId, toolName });
    toast({ title: `Tool archived: ${toolName}`, tone: "warn" });
    refresh();
  }

  async function onRestoreTool(toolName: string): Promise<void> {
    await restoreToolAction({ companyId, toolName });
    toast({ title: `Tool restored: ${toolName}`, tone: "success" });
    refresh();
  }

  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <h2 style={sectionTitleStyle}>Tool Config</h2>
        <p style={mutedTextStyle}>{activeTools.length} active / {archivedTools.length} archived</p>
      </div>

      <div style={{ display: "flex", gap: "6px" }}>
        <button type="button" style={filterTabStyle(statusFilter === "active")} onClick={() => setStatusFilter("active")}>
          활성 ({activeTools.length})
        </button>
        <button type="button" style={filterTabStyle(statusFilter === "archived")} onClick={() => setStatusFilter("archived")}>
          보관 ({archivedTools.length})
        </button>
      </div>

      {statusFilter === "active" && (
      <form onSubmit={(event) => void onCreateTool(event)} style={{ display: "grid", gap: "10px" }}>
        <div style={gridCols2Style}>
          <input
            placeholder="Tool name (e.g. ripgrep)"
            style={inputStyle}
            value={form.name}
            onChange={(event) => setForm((prev) => ({ ...prev, name: event.target.value }))}
            required
          />
          <input
            placeholder="Command (e.g. rg)"
            style={inputStyle}
            value={form.command}
            onChange={(event) => setForm((prev) => ({ ...prev, command: event.target.value }))}
            required
          />
          <input
            placeholder="Working directory (optional)"
            style={inputStyle}
            value={form.workingDirectory}
            onChange={(event) => setForm((prev) => ({ ...prev, workingDirectory: event.target.value }))}
          />
          <input
            placeholder="Description"
            style={inputStyle}
            value={form.description}
            onChange={(event) => setForm((prev) => ({ ...prev, description: event.target.value }))}
          />
        </div>
        <textarea
          placeholder="Instructions (에이전트에게 전달할 사용법)"
          style={{ ...inputStyle, minHeight: "150px", resize: "vertical", width: "100%", gridColumn: "1 / -1" }}
          value={form.instructions}
          onChange={(event) => setForm((prev) => ({ ...prev, instructions: event.target.value }))}
          rows={3}
        />

        <div>
          <button style={primaryButtonStyle} type="submit">
            Create Tool
          </button>
        </div>
      </form>
      )}

      <ToolTable
        tools={filteredTools}
        companyId={companyId}
        updateToolAction={updateToolAction}
        onDeleteTool={onDeleteTool}
        onRestoreTool={onRestoreTool}
        refresh={refresh}
        toast={toast}
        statusFilter={statusFilter}
      />

      {false && <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Name</th>
            <th style={thStyle}>Command</th>
            <th style={thStyle}>Approval</th>
            <th style={thStyle}>Updated</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.tools.map((tool) => (
            <tr key={tool.id}>
              <td style={tdStyle}>
                <strong>{tool.data.name}</strong>
                <div style={mutedTextStyle}>{tool.data.description || "-"}</div>
              </td>
              <td style={tdStyle}>
                <code>{tool.data.command}</code>
                <div style={mutedTextStyle}>{tool.data.workingDirectory || "cwd: default"}</div>
              </td>
              <td style={tdStyle}>{tool.data.requiresApproval ? "Yes" : "No"}</td>
              <td style={tdStyle}>{formatDateTime(tool.data.updatedAt || tool.updatedAt)}</td>
              <td style={tdStyle}>
                <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                  <button type="button" style={buttonStyle} onClick={() => void onToggleApproval(tool)}>
                    Toggle Approval
                  </button>
                  <button type="button" style={buttonStyle} onClick={() => void onDeleteTool(tool.data.name)}>
                    Delete
                  </button>
                </div>
              </td>
            </tr>
          ))}
          {data.tools.length === 0 ? (
            <tr>
              <td colSpan={5} style={tdStyle}>
                <p style={mutedTextStyle}>No tools configured yet.</p>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>}
    </section>
  );
}

function ToolTable({
  tools, companyId, updateToolAction, onDeleteTool, onRestoreTool, refresh, toast, statusFilter,
}: {
  tools: ToolConfigRecord[];
  companyId: string;
  updateToolAction: ReturnType<typeof usePluginAction>;
  onDeleteTool: (name: string) => Promise<void>;
  onRestoreTool: (name: string) => Promise<void>;
  refresh: () => void;
  toast: ReturnType<typeof usePluginToast>;
  statusFilter: StatusFilter;
}) {
  const [editingName, setEditingName] = useState<string | null>(null);
  const [editForm, setEditForm] = useState({ command: "", workingDirectory: "", description: "", instructions: "" });

  function beginEdit(tool: ToolConfigRecord) {
    setEditingName(tool.data.name);
    setEditForm({
      command: tool.data.command,
      workingDirectory: tool.data.workingDirectory || "",
      description: tool.data.description || "",
      instructions: tool.data.instructions || "",
    });
  }

  async function saveEdit(toolName: string) {
    await updateToolAction({
      companyId,
      toolName,
      patch: {
        command: editForm.command,
        workingDirectory: editForm.workingDirectory || undefined,
        description: editForm.description || undefined,
        instructions: editForm.instructions || undefined,
      },
    });
    toast({ title: `Tool updated: ${toolName}`, tone: "success" });
    setEditingName(null);
    refresh();
  }

  return (
    <table style={tableStyle}>
      <thead>
        <tr>
          <th style={thStyle}>Name</th>
          <th style={thStyle}>Command</th>
          <th style={thStyle}>Actions</th>
        </tr>
      </thead>
      <tbody>
        {tools.map((tool) => {
          const isEditing = editingName === tool.data.name;
          return (
            <tr key={tool.id}>
              {isEditing ? (
                <td style={tdStyle} colSpan={3}>
                  <div style={{ display: "grid", gap: "8px" }}>
                    <strong>{tool.data.name}</strong>
                    <input style={inputStyle} value={editForm.command} placeholder="Command" onChange={(e) => setEditForm((p) => ({ ...p, command: e.target.value }))} />
                    <input style={inputStyle} value={editForm.workingDirectory} placeholder="Working directory" onChange={(e) => setEditForm((p) => ({ ...p, workingDirectory: e.target.value }))} />
                    <input style={inputStyle} value={editForm.description} placeholder="Description" onChange={(e) => setEditForm((p) => ({ ...p, description: e.target.value }))} />
                    <textarea style={{ ...inputStyle, minHeight: "180px", resize: "vertical", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace", fontSize: "12px" }} value={editForm.instructions} placeholder="Instructions (에이전트 사용법)" onChange={(e) => setEditForm((p) => ({ ...p, instructions: e.target.value }))} rows={5} />
                    <div style={{ display: "flex", gap: "6px" }}>
                      <button type="button" style={primaryButtonStyle} onClick={() => void saveEdit(tool.data.name)}>Save</button>
                      <button type="button" style={buttonStyle} onClick={() => setEditingName(null)}>Cancel</button>
                    </div>
                  </div>
                </td>
              ) : (
                <>
                  <td style={tdStyle}>
                    <strong>{tool.data.name}</strong>
                    <div style={mutedTextStyle}>{tool.data.description || "-"}</div>
                    {tool.data.instructions && <div style={{ ...mutedTextStyle, fontSize: "11px", marginTop: "4px" }}>📋 instructions 있음</div>}
                  </td>
                  <td style={tdStyle}>
                    <code>{tool.data.command}</code>
                    <div style={mutedTextStyle}>{tool.data.workingDirectory || "cwd: default"}</div>
                  </td>
                  <td style={tdStyle}>
                    <div style={{ display: "flex", gap: "6px", flexWrap: "wrap" }}>
                      {statusFilter === "active" ? (
                        <>
                          <button type="button" style={primaryButtonStyle} onClick={() => beginEdit(tool)}>Edit</button>
                          <button type="button" style={buttonStyle} onClick={() => void onDeleteTool(tool.data.name)}>보관</button>
                        </>
                      ) : (
                        <button type="button" style={primaryButtonStyle} onClick={() => void onRestoreTool(tool.data.name)}>복원</button>
                      )}
                    </div>
                  </td>
                </>
              )}
            </tr>
          );
        })}
        {tools.length === 0 && (
          <tr><td colSpan={3} style={tdStyle}><p style={mutedTextStyle}>No tools configured yet.</p></td></tr>
        )}
      </tbody>
    </table>
  );
}

function GrantSection({
  data,
  companyId,
  refresh,
}: {
  data: PageData;
  companyId: string;
  refresh: () => void;
}): JSX.Element {
  const toast = usePluginToast();
  const grantToolAction = usePluginAction(ACTION_KEYS.grantTool);
  const revokeToolAction = usePluginAction(ACTION_KEYS.revokeTool);

  const [agentName, setAgentName] = useState<string>("");
  const [toolName, setToolName] = useState<string>("");

  const sortedAgentNames = useMemo(
    () => data.agents.map((agent) => agent.name).sort((left, right) => left.localeCompare(right)),
    [data.agents],
  );

  async function onGrant(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();

    await grantToolAction({
      companyId,
      agentName,
      toolName,
      grantedBy: "tool-registry-ui",
    });

    toast({ title: `Granted ${toolName} to ${agentName}`, tone: "success" });
    refresh();
  }

  async function onRevoke(targetAgentName: string, targetToolName: string): Promise<void> {
    await revokeToolAction({
      companyId,
      agentName: targetAgentName,
      toolName: targetToolName,
    });

    toast({ title: `Revoked ${targetToolName} from ${targetAgentName}`, tone: "warn" });
    refresh();
  }

  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <h2 style={sectionTitleStyle}>Agent Grants</h2>
        <p style={mutedTextStyle}>{data.grants.length} grants</p>
      </div>

      <form onSubmit={(event) => void onGrant(event)} style={{ display: "grid", gap: "10px" }}>
        <div style={gridCols2Style}>
          <select
            style={inputStyle}
            value={agentName}
            onChange={(event) => setAgentName(event.target.value)}
            required
          >
            <option value="">Select agent</option>
            {sortedAgentNames.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>

          <select
            style={inputStyle}
            value={toolName}
            onChange={(event) => setToolName(event.target.value)}
            required
          >
            <option value="">Select tool</option>
            {data.tools.map((tool) => (
              <option key={tool.id} value={tool.data.name}>
                {tool.data.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <button style={primaryButtonStyle} type="submit">
            Grant Tool
          </button>
        </div>
      </form>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Agent</th>
            <th style={thStyle}>Tool</th>
            <th style={thStyle}>Granted By</th>
            <th style={thStyle}>Granted At</th>
            <th style={thStyle}>Actions</th>
          </tr>
        </thead>
        <tbody>
          {data.grants.map((grant) => (
            <tr key={grant.id}>
              <td style={tdStyle}>{grant.data.agentName}</td>
              <td style={tdStyle}>{grant.data.toolName}</td>
              <td style={tdStyle}>{grant.data.grantedBy}</td>
              <td style={tdStyle}>{formatDateTime(grant.data.grantedAt)}</td>
              <td style={tdStyle}>
                <button
                  type="button"
                  style={buttonStyle}
                  onClick={() => void onRevoke(grant.data.agentName, grant.data.toolName)}
                >
                  Revoke
                </button>
              </td>
            </tr>
          ))}
          {data.grants.length === 0 ? (
            <tr>
              <td colSpan={5} style={tdStyle}>
                <p style={mutedTextStyle}>No grants configured yet.</p>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function LogsSection({ data }: { data: PageData }): JSX.Element {
  return (
    <section style={cardStyle}>
      <div style={headerRowStyle}>
        <h2 style={sectionTitleStyle}>Recent Execution Logs</h2>
        <p style={mutedTextStyle}>{data.logs.length} entries</p>
      </div>

      <table style={tableStyle}>
        <thead>
          <tr>
            <th style={thStyle}>Time</th>
            <th style={thStyle}>Agent</th>
            <th style={thStyle}>Tool</th>
            <th style={thStyle}>Mode</th>
            <th style={thStyle}>Exit</th>
            <th style={thStyle}>Summary</th>
          </tr>
        </thead>
        <tbody>
          {data.logs.map((entry) => {
            const log = entry.data;
            const summary = log.reason || log.stderr || log.stdout || "-";

            return (
              <tr key={entry.id}>
                <td style={tdStyle}>{formatDateTime(log.timestamp || entry.createdAt)}</td>
                <td style={tdStyle}>{log.agentName || log.agentId}</td>
                <td style={tdStyle}>{log.toolName}</td>
                <td style={tdStyle}>{log.mode}</td>
                <td style={tdStyle}>{log.exitCode == null ? "-" : String(log.exitCode)}</td>
                <td style={tdStyle}>
                  <pre style={codeStyle}>{truncate(summary, 160) || "-"}</pre>
                </td>
              </tr>
            );
          })}
          {data.logs.length === 0 ? (
            <tr>
              <td colSpan={6} style={tdStyle}>
                <p style={mutedTextStyle}>No execution logs yet.</p>
              </td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </section>
  );
}

function HelpSection(): JSX.Element {
  const [showHelp, setShowHelp] = useState(false);

  return (
    <section style={cardStyle}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <h2 style={sectionTitleStyle}>Help</h2>
        <button type="button" style={buttonStyle} onClick={() => setShowHelp(!showHelp)}>
          {showHelp ? "닫기" : "도움말"}
        </button>
      </div>
      {showHelp && (
        <div style={mutedTextStyle}>
          <p style={{ ...mutedTextStyle, fontWeight: 600, fontSize: "15px", marginBottom: "8px" }}>Tool Registry 도움말</p>

          <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>기본 개념</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li><strong>Tool</strong>: CLI 명령어를 래핑한 실행 가능한 도구</li>
            <li><strong>Grant</strong>: 에이전트별 도구 사용 권한</li>
            <li><strong>Instructions</strong>: 에이전트에게 전달되는 도구 사용법</li>
          </ul>

          <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>도구 등록</p>
          <ol style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li><strong>Name</strong>: 고유 이름 (workflow에서 참조)</li>
            <li><strong>Command</strong>: 실행할 CLI 명령어</li>
            <li><strong>Working Directory</strong>: 실행 경로 (비워두면 기본값)</li>
            <li><strong>Description</strong>: 도구 설명</li>
            <li><strong>Instructions</strong>: 에이전트에게 전달할 상세 사용법
              <ul style={{ margin: "2px 0", paddingLeft: "16px" }}>
                <li>Workflow의 Agent step에서 tools에 이 도구를 지정하면 자동 전달</li>
              </ul>
            </li>
          </ol>

          <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>Grant 관리</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li>에이전트 이름 + 도구 이름으로 사용 권한 부여</li>
            <li>Grant가 없으면 에이전트가 직접 실행 불가</li>
            <li>Workflow Engine의 Tool step은 Grant 없이 시스템으로 실행</li>
          </ul>

          <p style={{ ...mutedTextStyle, fontWeight: 600, marginTop: "12px" }}>실행 로그</p>
          <ul style={{ margin: "4px 0", paddingLeft: "20px" }}>
            <li>모든 도구 실행이 기록됨 (성공/실패/거부)</li>
          </ul>
        </div>
      )}
    </section>
  );
}

export function ToolRegistryPage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const toast = usePluginToast();
  const companyId = hostContext.companyId ?? props.context.companyId ?? "";

  const page = usePluginData<PageData>(DATA_KEYS.pageData, {
    companyId,
    maxLogEntries: 50,
  });

  if (!companyId) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Tool Registry</h1>
        <p style={mutedTextStyle}>Company context is required.</p>
      </main>
    );
  }

  if (page.loading) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Tool Registry</h1>
        <p style={mutedTextStyle}>Loading...</p>
      </main>
    );
  }

  if (page.error || !page.data) {
    return (
      <main style={pageStyle}>
        <h1 style={titleStyle}>Tool Registry</h1>
        <p style={mutedTextStyle}>{page.error?.message ?? "Failed to load tool registry data."}</p>
        <div>
          <button style={buttonStyle} type="button" onClick={() => page.refresh()}>
            Retry
          </button>
        </div>
      </main>
    );
  }

  const data = page.data;

  function refresh(): void {
    page.refresh();
  }

  return (
    <main style={pageStyle}>
      <div style={headerRowStyle}>
        <div>
          <h1 style={titleStyle}>Tool Registry</h1>
          <p style={mutedTextStyle}>Company: {data.companyName ?? companyId}</p>
        </div>

        <button
          style={buttonStyle}
          type="button"
          onClick={() => {
            refresh();
            toast({ title: "Refreshed tool registry", tone: "info" });
          }}
        >
          Refresh
        </button>
      </div>

      <ToolSection data={data} companyId={companyId} refresh={refresh} />
      <GrantSection data={data} companyId={companyId} refresh={refresh} />
      <LogsSection data={data} />
      <HelpSection />
    </main>
  );
}

export function ToolRegistrySidebarLink({ context }: { context: { companyPrefix?: string | null } }) {
  const href = context.companyPrefix ? `/${context.companyPrefix}/tool-registry` : "/tool-registry";
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
      <span>🔧 Tool Registry</span>
    </a>
  );
}
