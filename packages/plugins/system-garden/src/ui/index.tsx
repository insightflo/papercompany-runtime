import { usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { NODE_COLORS, PAGE_ROUTE } from "../constants.js";
import type { AgentDetailSnapshot, GardenSnapshot, GraphEdge, GraphNode, HealthCard, MetaQuestion } from "../worker.js";

type CytoscapeElementPayload = {
  group: "nodes" | "edges";
  data: {
    id?: string;
    source?: string;
    target?: string;
    label?: string;
    kind?: string;
    status?: string;
    role?: string;
  };
};

type CytoscapeNode = {
  id(): string;
  closedNeighborhood(): CytoscapeCollection;
  connectedEdges(): CytoscapeCollection;
};

type CytoscapeCollection = {
  addClass(className: string): CytoscapeCollection;
  removeClass(className: string): CytoscapeCollection;
};

type CytoscapeCore = {
  elements(): CytoscapeCollection & {
    not(collection: CytoscapeCollection): CytoscapeCollection;
  };
  on(eventName: string, selector: string, handler: (event: { target: CytoscapeNode }) => void): void;
  destroy(): void;
};

type CytoscapeFactory = (options: {
  container: HTMLElement;
  elements: CytoscapeElementPayload[];
  style: Array<{ selector: string; style: Record<string, string | number> }>;
  layout: { name: "cose"; animate: boolean; fit: boolean; padding: number };
}) => CytoscapeCore;

type GraphLayerFilter = "all" | "agent" | "code" | "issue";

let cytoscapeLoader: Promise<CytoscapeFactory> | null = null;

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "20px",
  padding: "22px",
  color: "var(--foreground, #e2e8f0)",
  background: [
    "radial-gradient(circle at 8% -10%, color-mix(in srgb, #334155 42%, transparent) 0%, transparent 40%)",
    "radial-gradient(circle at 90% 0%, color-mix(in srgb, #1e293b 40%, transparent) 0%, transparent 36%)",
    "linear-gradient(180deg, color-mix(in srgb, var(--background, #0f172a) 100%, #020617), #020617)",
  ].join(", "),
  minHeight: "100%",
};

const panelStyle: CSSProperties = {
  borderRadius: "18px",
  border: "1px solid color-mix(in srgb, var(--border, #334155) 74%, transparent)",
  background: "color-mix(in srgb, var(--card, #0b1220) 94%, transparent)",
  boxShadow: "0 22px 70px rgba(2, 6, 23, 0.35)",
};

const panelTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: "18px",
  lineHeight: 1.15,
};

const mutedStyle: CSSProperties = {
  color: "color-mix(in srgb, var(--foreground, #e2e8f0) 62%, transparent)",
  fontSize: "12px",
  lineHeight: 1.5,
};

function hostPath(companyPrefix: string | null | undefined, suffix: string): string {
  return companyPrefix ? `/${companyPrefix}${suffix}` : suffix;
}

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return hostPath(companyPrefix, `/${PAGE_ROUTE}`);
}

function loadCytoscape(): Promise<CytoscapeFactory> {
  if (!cytoscapeLoader) {
    cytoscapeLoader = import("cytoscape").then((module) => (module as { default: CytoscapeFactory }).default);
  }
  return cytoscapeLoader;
}

function buildElements(nodes: GraphNode[], edges: GraphEdge[]): CytoscapeElementPayload[] {
  const nodeElements: CytoscapeElementPayload[] = nodes.map((node) => ({
    group: "nodes",
    data: {
      id: node.id,
      label: node.label,
      kind: node.kind,
      status: node.status,
      role: node.role,
    },
  }));
  const edgeElements: CytoscapeElementPayload[] = edges.map((edge) => ({
    group: "edges",
    data: {
      source: edge.source,
      target: edge.target,
      label: edge.label,
    },
  }));
  return [...nodeElements, ...edgeElements];
}

const CODE_NODE_KINDS = new Set<GraphNode["kind"]>(["module", "file", "function", "class"]);

function isCodeNode(node: GraphNode): boolean {
  return CODE_NODE_KINDS.has(node.kind);
}

function isIssueNode(node: GraphNode): boolean {
  return node.kind === "issue";
}

function filterGraphByLayer(
  nodes: GraphNode[],
  edges: GraphEdge[],
  layerFilter: GraphLayerFilter,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const filteredNodes = nodes.filter((node) => {
    if (layerFilter === "all") return true;
    if (layerFilter === "agent") return node.kind === "agent";
    if (layerFilter === "code") return isCodeNode(node);
    if (layerFilter === "issue") return isIssueNode(node);
    return true;
  });

  const nodeIds = new Set(filteredNodes.map((node) => node.id));
  if (layerFilter === "issue") {
    const connectedAgentIds = new Set<string>();
    for (const edge of edges) {
      const source = nodeById.get(edge.source);
      const target = nodeById.get(edge.target);
      if (source?.kind === "issue" && target?.kind === "agent" && edge.label === "assignee") {
        connectedAgentIds.add(target.id);
      }
      if (source?.kind === "agent" && target?.kind === "issue" && edge.label === "assignee") {
        connectedAgentIds.add(source.id);
      }
    }
    for (const agentId of connectedAgentIds) nodeIds.add(agentId);
  }
  const filteredIssueNodes = nodes.filter((node) => nodeIds.has(node.id));
  const filteredEdges = edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));
  return { nodes: filteredIssueNodes, edges: filteredEdges };
}

function scoreTone(score: number): { color: string; background: string; border: string } {
  if (score >= 80) {
    return {
      color: "#16a34a",
      background: "color-mix(in srgb, #22c55e 16%, transparent)",
      border: "1px solid color-mix(in srgb, #22c55e 36%, transparent)",
    };
  }
  if (score >= 50) {
    return {
      color: "#d97706",
      background: "color-mix(in srgb, #f59e0b 16%, transparent)",
      border: "1px solid color-mix(in srgb, #f59e0b 36%, transparent)",
    };
  }
  return {
    color: "#dc2626",
    background: "color-mix(in srgb, #ef4444 16%, transparent)",
    border: "1px solid color-mix(in srgb, #ef4444 36%, transparent)",
  };
}

export function HealthCardRow({ cards }: { cards: HealthCard[] }) {
  return (
    <div
      style={{
        display: "grid",
        gap: "12px",
        gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))",
      }}
    >
      {cards.map((card) => {
        const tone = scoreTone(card.score);
        const deltaLabel = card.delta
          ? card.delta.direction === "flat"
            ? "0"
            : `${card.delta.direction === "up" ? "+" : "-"}${Math.abs(card.delta.diff)}`
          : null;
        return (
          <article
            key={card.name}
            style={{
              ...panelStyle,
              display: "grid",
              gap: "8px",
              padding: "14px",
              border: tone.border,
              background: `linear-gradient(165deg, ${tone.background}, color-mix(in srgb, var(--card, #0b1220) 92%, transparent))`,
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: "8px" }}>
              <strong style={{ fontSize: "14px" }}>{card.name}</strong>
              <span style={{ ...mutedStyle, color: tone.color }}>{card.state}</span>
            </div>
            <div style={{ display: "flex", gap: "10px", alignItems: "baseline" }}>
              <strong style={{ fontSize: "28px", lineHeight: 1, color: tone.color }}>{card.score}</strong>
              {deltaLabel ? <span style={mutedStyle}>Δ {deltaLabel}</span> : null}
            </div>
            <div style={mutedStyle}>{card.detail}</div>
          </article>
        );
      })}
    </div>
  );
}

export function QuestionList({ questions }: { questions: MetaQuestion[] }) {
  return (
    <div style={{ display: "grid", gap: "10px" }}>
      {questions.map((question, index) => (
        <article key={`${question.text}-${index}`} style={{ ...panelStyle, display: "grid", gap: "4px", padding: "12px 14px" }}>
          <div style={{ fontSize: "14px", lineHeight: 1.5 }}>{question.text}</div>
          <div style={mutedStyle}>{question.actionHint}</div>
        </article>
      ))}
    </div>
  );
}

type IssueLink = {
  node: GraphNode;
  relation: string;
  direction: "incoming" | "outgoing";
};

function collectIssueLinks(selectedNodeId: string, nodes: GraphNode[], edges: GraphEdge[]): {
  incomingIssueLinks: IssueLink[];
  outgoingIssueLinks: IssueLink[];
  assigneeLinks: IssueLink[];
} {
  const nodeById = new Map(nodes.map((node) => [node.id, node] as const));
  const incomingIssueLinks: IssueLink[] = [];
  const outgoingIssueLinks: IssueLink[] = [];
  const assigneeLinks: IssueLink[] = [];

  for (const edge of edges) {
    if (edge.source === selectedNodeId) {
      const target = nodeById.get(edge.target);
      if (!target) continue;
      const link: IssueLink = { node: target, relation: edge.label, direction: "outgoing" };
      if (target.kind === "agent" && edge.label === "assignee") assigneeLinks.push(link);
      if (target.kind === "issue") outgoingIssueLinks.push(link);
    }

    if (edge.target === selectedNodeId) {
      const source = nodeById.get(edge.source);
      if (!source) continue;
      const link: IssueLink = { node: source, relation: edge.label, direction: "incoming" };
      if (source.kind === "agent" && edge.label === "assignee") assigneeLinks.push(link);
      if (source.kind === "issue") incomingIssueLinks.push(link);
    }
  }

  return { incomingIssueLinks, outgoingIssueLinks, assigneeLinks };
}

function IssueLinkList({
  title,
  links,
}: {
  title: string;
  links: IssueLink[];
}) {
  if (links.length === 0) return null;

  return (
    <div style={{ display: "grid", gap: "6px" }}>
      <div style={{ ...mutedStyle, fontSize: "11px", textTransform: "uppercase", letterSpacing: "0.06em" }}>{title}</div>
      {links.map((link) => (
        <div
          key={`${title}-${link.direction}-${link.node.id}-${link.relation}`}
          style={{
            padding: "8px 10px",
            borderRadius: "10px",
            border: "1px solid color-mix(in srgb, var(--border, #334155) 74%, transparent)",
            background: "color-mix(in srgb, var(--background, #020617) 68%, transparent)",
          }}
        >
          <div style={{ fontSize: "13px", lineHeight: 1.4 }}>{link.node.label}</div>
          <div style={mutedStyle}>
            {link.relation} · {link.node.kind}
            {link.node.summary ? ` · ${link.node.summary}` : ""}
          </div>
        </div>
      ))}
    </div>
  );
}

function NodeDetailPanel({
  selectedNode,
  detail,
  loading,
  nodes,
  edges,
}: {
  selectedNode: GraphNode | null;
  detail: AgentDetailSnapshot | null;
  loading: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
}) {
  if (!selectedNode) {
    return <div style={mutedStyle}>노드를 클릭하면 상세 정보가 표시됩니다.</div>;
  }

  if (selectedNode.kind === "issue") {
    const { incomingIssueLinks, outgoingIssueLinks, assigneeLinks } = collectIssueLinks(selectedNode.id, nodes, edges);
    return (
      <div style={{ display: "grid", gap: "10px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <strong style={{ fontSize: "15px" }}>{selectedNode.label}</strong>
          <div style={mutedStyle}>
            status: {selectedNode.status} · prefix: {selectedNode.role} · layer: {selectedNode.layer ?? "n/a"}
          </div>
        </div>
        {selectedNode.summary ? <div style={{ fontSize: "13px", lineHeight: 1.5 }}>{selectedNode.summary}</div> : null}
        <IssueLinkList title="Assignees" links={assigneeLinks} />
        <IssueLinkList title="Inbound issues" links={incomingIssueLinks} />
        <IssueLinkList title="Outbound issues" links={outgoingIssueLinks} />
      </div>
    );
  }

  if (selectedNode.kind !== "agent") {
    return (
      <div style={{ display: "grid", gap: "10px" }}>
        <div style={{ display: "grid", gap: "4px" }}>
          <strong style={{ fontSize: "15px" }}>{selectedNode.label}</strong>
          <div style={mutedStyle}>
            kind: {selectedNode.kind} · layer: {selectedNode.layer ?? "n/a"}
          </div>
        </div>
        {selectedNode.summary ? <div style={{ fontSize: "13px", lineHeight: 1.5 }}>{selectedNode.summary}</div> : null}
        <div style={mutedStyle}>코드 KG 노드는 최근 이슈 목록 대신 구조 메타데이터를 표시합니다.</div>
      </div>
    );
  }

  return (
    <div style={{ display: "grid", gap: "10px" }}>
      <div style={{ display: "grid", gap: "4px" }}>
        <strong style={{ fontSize: "15px" }}>{selectedNode.label}</strong>
        <div style={mutedStyle}>
          status: {selectedNode.status} · role: {selectedNode.role}
        </div>
      </div>

      {loading ? <div style={mutedStyle}>최근 이슈를 조회하는 중...</div> : null}
      {!loading && detail?.recentIssues.length === 0 ? <div style={mutedStyle}>최근 이슈가 없습니다.</div> : null}
      {!loading && detail ? (
        <div style={{ display: "grid", gap: "8px" }}>
          {detail.recentIssues.map((issue) => (
            <div
              key={issue.id}
              style={{
                padding: "8px 10px",
                borderRadius: "10px",
                border: "1px solid color-mix(in srgb, var(--border, #334155) 74%, transparent)",
                background: "color-mix(in srgb, var(--background, #020617) 68%, transparent)",
              }}
            >
              <div style={{ fontSize: "13px", lineHeight: 1.4 }}>{issue.title}</div>
              <div style={mutedStyle}>{issue.identifier ?? issue.id.slice(0, 8)} · {issue.status}</div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function SystemGardenPage({ context }: PluginPageProps) {
  const snapshot = usePluginData<GardenSnapshot>("system-garden-snapshot", {
    companyId: context.companyId ?? "",
  });
  const [layerFilter, setLayerFilter] = useState<GraphLayerFilter>("issue");
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [graphError, setGraphError] = useState<string | null>(null);
  const graphRef = useRef<HTMLDivElement | null>(null);

  const filteredGraph = useMemo(() => {
    if (!snapshot.data) return { nodes: [], edges: [] };
    return filterGraphByLayer(snapshot.data.graph.nodes, snapshot.data.graph.edges, layerFilter);
  }, [snapshot.data, layerFilter]);

  const selectedNode = useMemo(
    () => filteredGraph.nodes.find((node) => node.id === selectedNodeId) ?? null,
    [filteredGraph.nodes, selectedNodeId],
  );

  const selectedAgent = selectedNode?.kind === "agent" ? selectedNode : null;

  const detail = usePluginData<AgentDetailSnapshot | null>("system-garden-agent-detail", {
    companyId: context.companyId ?? "",
    agentId: selectedAgent?.id ?? "",
  });

  useEffect(() => {
    if (!selectedNodeId) return;
    if (filteredGraph.nodes.some((node) => node.id === selectedNodeId)) return;
    setSelectedNodeId(null);
  }, [filteredGraph.nodes, selectedNodeId]);

  useEffect(() => {
    if (!snapshot.data || !graphRef.current) return;

    let disposed = false;
    let instance: CytoscapeCore | null = null;
    setGraphError(null);

    const mount = async () => {
      const cytoscape = await loadCytoscape();
      if (disposed || !graphRef.current) return;

      instance = cytoscape({
        container: graphRef.current,
        elements: buildElements(filteredGraph.nodes, filteredGraph.edges),
        style: [
          {
            selector: "node",
            style: {
              "background-color": NODE_COLORS.default,
              color: "#f8fafc",
              "font-size": 11,
              label: "data(label)",
              "text-valign": "center",
              "text-halign": "center",
              "text-wrap": "wrap",
              "text-max-width": 92,
              width: 42,
              height: 42,
              "border-width": 2,
              "border-color": "#0a1628",
            },
          },
          {
            selector: "node[kind = 'agent']",
            style: {
              "background-color": NODE_COLORS.agent,
            },
          },
          {
            selector: "node[kind = 'module'], node[kind = 'file']",
            style: {
              "background-color": NODE_COLORS.module,
            },
          },
          {
            selector: "node[kind = 'function']",
            style: {
              "background-color": NODE_COLORS.function,
            },
          },
          {
            selector: "node[kind = 'class']",
            style: {
              "background-color": NODE_COLORS.class,
            },
          },
          {
            selector: "node[kind = 'issue']",
            style: {
              "background-color": NODE_COLORS.issue,
              shape: "round-rectangle",
              width: 54,
              height: 38,
              "font-size": 10,
              "text-max-width": 84,
            },
          },
          {
            selector: "edge",
            style: {
              width: 2,
              "line-color": "#5d6b7e",
              "target-arrow-color": "#6b7a8d",
              "target-arrow-shape": "triangle",
              "curve-style": "bezier",
              label: "data(label)",
              "font-size": 9,
              color: "#9fb0c4",
              "text-background-color": "rgba(15, 23, 42, 0.86)",
              "text-background-opacity": 1,
              "text-background-padding": 2,
            },
          },
          {
            selector: ".faded",
            style: {
              opacity: 0.18,
            },
          },
          {
            selector: ".highlight",
            style: {
              "line-color": "#22d3ee",
              "target-arrow-color": "#22d3ee",
              width: 3,
            },
          },
        ],
        layout: {
          name: "cose",
          animate: true,
          fit: true,
          padding: 20,
        },
      });

      instance.on("tap", "node", (event) => {
        setSelectedNodeId(event.target.id());
      });

      instance.on("mouseover", "node", (event) => {
        if (!instance) return;
        const neighborhood = event.target.closedNeighborhood();
        instance.elements().removeClass("faded");
        instance.elements().not(neighborhood).addClass("faded");
        event.target.connectedEdges().addClass("highlight");
      });

      instance.on("mouseout", "node", () => {
        if (!instance) return;
        instance.elements().removeClass("faded");
        instance.elements().removeClass("highlight");
      });
    };

    mount().catch((error) => {
      if (disposed) return;
      setGraphError(error instanceof Error ? error.message : "그래프를 초기화하지 못했습니다.");
    });
    return () => {
      disposed = true;
      if (instance) instance.destroy();
    };
  }, [snapshot.data, filteredGraph]);

  if (snapshot.loading) return <div style={pageStyle}>System Garden 데이터를 불러오는 중...</div>;
  if (snapshot.error) return <div style={pageStyle}>System Garden 데이터 오류: {snapshot.error.message}</div>;
  if (!snapshot.data) return <div style={pageStyle}>표시할 데이터가 없습니다.</div>;

  return (
    <div style={pageStyle}>
      <header style={{ ...panelStyle, padding: "18px 20px", display: "grid", gap: "8px" }}>
        <h1 style={{ margin: 0, fontSize: "clamp(26px, 3.2vw, 38px)", lineHeight: 1.03 }}>System Garden</h1>
        <div style={{ ...mutedStyle, fontSize: "13px" }}>
          에이전트 그래프, 코드 KG, 미션보드 이슈 그래프를 규칙 기반으로 합쳐 운영 건강도와 후속 미션 관계를 점검합니다.
        </div>
        <div style={mutedStyle}>
          agents: {snapshot.data.meta.agentCount} · issues: {snapshot.data.meta.issueCount}
          {typeof snapshot.data.meta.missionSeedCount === "number" ? ` · mission seeds: ${snapshot.data.meta.missionSeedCount}` : ""}
          {typeof snapshot.data.meta.missionIssueCount === "number" ? ` · mission issues: ${snapshot.data.meta.missionIssueCount}` : ""}
          {typeof snapshot.data.meta.missionIssueEdgeCount === "number" ? ` · mission edges: ${snapshot.data.meta.missionIssueEdgeCount}` : ""}
          · generated: {new Date(snapshot.data.meta.generatedAt).toLocaleString("ko-KR")}
        </div>
      </header>

      <section style={{ ...panelStyle, padding: "14px", display: "grid", gap: "12px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", gap: "10px", flexWrap: "wrap" }}>
          <h2 style={panelTitleStyle}>Graph</h2>
          <div style={{ display: "inline-flex", gap: "6px", background: "rgba(15,23,42,0.55)", borderRadius: "999px", padding: "4px" }}>
            {([
              { value: "issue", label: "미션보드" },
              { value: "agent", label: "에이전트만" },
              { value: "code", label: "코드만" },
              { value: "all", label: "전체" },
            ] as const).map((option) => (
              <button
                key={option.value}
                type="button"
                onClick={() => setLayerFilter(option.value)}
                style={{
                  border: "none",
                  borderRadius: "999px",
                  padding: "6px 10px",
                  fontSize: "12px",
                  cursor: "pointer",
                  color: layerFilter === option.value ? "#0f172a" : "#cbd5e1",
                  background: layerFilter === option.value ? "#67e8f9" : "transparent",
                }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <div style={{ display: "grid", gap: "12px", gridTemplateColumns: "minmax(0, 2fr) minmax(280px, 1fr)" }}>
          <div
            ref={graphRef}
            style={{
              width: "100%",
              minHeight: "440px",
              display: "grid",
              placeItems: "center",
              borderRadius: "14px",
              border: "1px solid color-mix(in srgb, var(--border, #334155) 76%, transparent)",
              background: "color-mix(in srgb, var(--background, #020617) 75%, transparent)",
            }}
          >
            {graphError ? (
              <div style={{ ...mutedStyle, maxWidth: "320px", textAlign: "center", padding: "16px" }}>
                그래프를 불러오지 못했습니다. {graphError}
              </div>
            ) : filteredGraph.nodes.length === 0 ? (
              <div style={{ ...mutedStyle, maxWidth: "320px", textAlign: "center", padding: "16px" }}>
                현재 레이어 필터에 표시할 그래프가 없습니다.
              </div>
            ) : null}
          </div>
          <aside
            style={{
              borderRadius: "14px",
              border: "1px solid color-mix(in srgb, var(--border, #334155) 76%, transparent)",
              background: "color-mix(in srgb, var(--card, #0b1220) 92%, transparent)",
              padding: "12px",
            }}
          >
            <NodeDetailPanel
              selectedNode={selectedNode}
              detail={detail.data ?? null}
              loading={detail.loading}
              nodes={filteredGraph.nodes}
              edges={filteredGraph.edges}
            />
          </aside>
        </div>
      </section>

      <section style={{ ...panelStyle, padding: "14px", display: "grid", gap: "12px" }}>
        <h2 style={panelTitleStyle}>Health</h2>
        <HealthCardRow cards={snapshot.data.cards} />
      </section>

      <section style={{ ...panelStyle, padding: "14px", display: "grid", gap: "12px" }}>
        <h2 style={panelTitleStyle}>Questions</h2>
        <QuestionList questions={snapshot.data.questions} />
      </section>
    </div>
  );
}

export function SystemGardenSidebarLink({ context }: PluginSidebarProps) {
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span aria-hidden="true">✳</span>
      <span className="truncate">System Garden</span>
    </a>
  );
}
