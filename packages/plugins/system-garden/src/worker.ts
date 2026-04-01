import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { HEALTH_LABELS, HEALTH_THRESHOLDS, PLUGIN_DISPLAY_NAME } from "./constants.js";
import { buildMissionIssueGraph } from "./issue-graph.js";

type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
type IssueRecord = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];

type AgentMetrics = {
  open: number;
  done: number;
  inReview: number;
  failedStreak: number;
  assigned: number;
};

export type GardenSnapshot = {
  meta: {
    generatedAt: string;
    agentCount: number;
    issueCount: number;
    missionIssueCount?: number;
    missionSeedCount?: number;
    missionIssueEdgeCount?: number;
  };
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  cards: HealthCard[];
  questions: MetaQuestion[];
};

const UA_KG_PATH_ENV = "SYSTEM_GARDEN_KG_PATH";

type UaGraphNode = {
  id?: unknown;
  type?: unknown;
  label?: unknown;
  name?: unknown;
  summary?: unknown;
  complexity?: unknown;
  layer?: unknown;
  metadata?: unknown;
};

type UaGraphEdge = {
  source?: unknown;
  from?: unknown;
  target?: unknown;
  to?: unknown;
  type?: unknown;
  label?: unknown;
};

type UaKnowledgeGraph = {
  nodes?: unknown;
  edges?: unknown;
};

export type GraphNodeKind = "agent" | "module" | "file" | "function" | "class" | "issue";
export type GraphNode = {
  id: string;
  label: string;
  kind: GraphNodeKind;
  status: string;
  role: string;
  summary?: string;
  complexity?: string;
  layer?: string;
};
export type GraphEdge = { source: string; target: string; label: string };
export type HealthCard = { name: string; score: number; state: string; detail: string; delta?: { diff: number; direction: string } };
export type MetaQuestion = { text: string; actionHint: string };

export type AgentIssueBrief = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
  updatedAt: string | null;
};

export type AgentDetailSnapshot = {
  agentId: string;
  name: string;
  status: string;
  role: string;
  recentIssues: AgentIssueBrief[];
};

const ACTIVE_STATUSES = new Set(["active", "idle", "running"]);
const OPEN_STATUSES = new Set(["backlog", "todo", "in_progress", "in_review", "blocked"]);
const FAILED_SIGNAL_STATUSES = new Set(["blocked", "cancelled"]);
const DAY_MS = 24 * 60 * 60 * 1000;

function getCompanyId(params: Record<string, unknown>): string {
  return typeof params.companyId === "string" ? params.companyId.trim() : "";
}

function getAgentId(params: Record<string, unknown>): string {
  return typeof params.agentId === "string" ? params.agentId.trim() : "";
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoString(value: Date | string | null | undefined): string | null {
  const parsed = toDate(value);
  return parsed ? parsed.toISOString() : null;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function toHealthState(score: number): string {
  if (score >= HEALTH_THRESHOLDS.good) return HEALTH_LABELS.good;
  if (score >= HEALTH_THRESHOLDS.warning) return HEALTH_LABELS.warning;
  return HEALTH_LABELS.bad;
}

function toRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function extractChainTargets(agent: AgentRecord): string[] {
  const metadata = toRecord(agent.metadata);
  const runtime = toRecord(agent.runtimeConfig);
  const direct = toRecord(agent as unknown);

  const combined = [
    ...toStringArray(direct?.chainOfCommand),
    ...toStringArray(metadata?.chainOfCommand),
    ...toStringArray(runtime?.chainOfCommand),
    ...toStringArray(metadata?.chain_of_command),
    ...toStringArray(runtime?.chain_of_command),
  ];

  return Array.from(new Set(combined));
}

function touchedAt(issue: IssueRecord): Date | null {
  return (
    toDate(issue.updatedAt)
    ?? toDate(issue.completedAt)
    ?? toDate(issue.cancelledAt)
    ?? toDate(issue.createdAt)
  );
}

function issueSortDesc(left: IssueRecord, right: IssueRecord): number {
  const leftTime = touchedAt(left)?.getTime() ?? 0;
  const rightTime = touchedAt(right)?.getTime() ?? 0;
  return rightTime - leftTime;
}

function buildGraph(agents: AgentRecord[]): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes: GraphNode[] = agents.map((agent) => ({
    id: agent.id,
    label: agent.name,
    kind: "agent",
    status: agent.status,
    role: agent.role,
  }));

  const idSet = new Set(nodes.map((node) => node.id));
  const seenEdges = new Set<string>();
  const edges: GraphEdge[] = [];

  for (const agent of agents) {
    if (agent.reportsTo && idSet.has(agent.reportsTo)) {
      const key = `${agent.id}->${agent.reportsTo}:reportsTo`;
      if (!seenEdges.has(key)) {
        seenEdges.add(key);
        edges.push({ source: agent.id, target: agent.reportsTo, label: "reportsTo" });
      }
    }

    for (const target of extractChainTargets(agent)) {
      if (!idSet.has(target)) continue;
      const key = `${agent.id}->${target}:chainOfCommand`;
      if (seenEdges.has(key)) continue;
      seenEdges.add(key);
      edges.push({ source: agent.id, target, label: "chainOfCommand" });
    }
  }

  return { nodes, edges };
}

function resolveUaKnowledgeGraphPath(): string {
  const fromEnv = process.env[UA_KG_PATH_ENV];
  if (typeof fromEnv === "string" && fromEnv.trim()) return path.resolve(fromEnv.trim());
  return path.resolve(process.cwd(), ".understand-anything", "knowledge-graph.json");
}

function toNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeCodeNodeKind(rawKind: string): GraphNodeKind {
  const kind = rawKind.toLowerCase();
  if (kind === "module" || kind === "file") return "module";
  if (kind === "function") return "function";
  if (kind === "class") return "class";
  return "module";
}

function codeNodeId(rawId: string): string {
  return `code:${rawId}`;
}

function extractLayer(value: unknown): string | undefined {
  const direct = toNonEmptyString(value);
  if (direct) return direct;
  const metadata = toRecord(value);
  const nested = toNonEmptyString(metadata?.layer);
  return nested || undefined;
}

function buildCodeGraph(knowledgeGraph: UaKnowledgeGraph | null): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (!knowledgeGraph) return { nodes: [], edges: [] };
  const rawNodes = Array.isArray(knowledgeGraph.nodes) ? knowledgeGraph.nodes : [];
  const rawEdges = Array.isArray(knowledgeGraph.edges) ? knowledgeGraph.edges : [];

  const nodes: GraphNode[] = [];
  const nodeIdMap = new Map<string, string>();
  for (const rawNode of rawNodes) {
    const nodeRecord = toRecord(rawNode) as UaGraphNode | null;
    if (!nodeRecord) continue;

    const rawId = toNonEmptyString(nodeRecord.id);
    if (!rawId) continue;

    const label = toNonEmptyString(nodeRecord.label) || toNonEmptyString(nodeRecord.name) || rawId;
    const rawType = toNonEmptyString(nodeRecord.type) || "module";
    const kind = normalizeCodeNodeKind(rawType);
    const layer = extractLayer(nodeRecord.layer) ?? extractLayer(nodeRecord.metadata);

    const mappedId = codeNodeId(rawId);
    nodeIdMap.set(rawId, mappedId);
    nodes.push({
      id: mappedId,
      label,
      kind,
      status: "code",
      role: rawType,
      summary: toNonEmptyString(nodeRecord.summary) || undefined,
      complexity: toNonEmptyString(nodeRecord.complexity) || undefined,
      layer,
    });
  }

  const edges: GraphEdge[] = [];
  const seenEdges = new Set<string>();
  for (const rawEdge of rawEdges) {
    const edgeRecord = toRecord(rawEdge) as UaGraphEdge | null;
    if (!edgeRecord) continue;

    const sourceRaw = toNonEmptyString(edgeRecord.source) || toNonEmptyString(edgeRecord.from);
    const targetRaw = toNonEmptyString(edgeRecord.target) || toNonEmptyString(edgeRecord.to);
    if (!sourceRaw || !targetRaw) continue;

    const source = nodeIdMap.get(sourceRaw);
    const target = nodeIdMap.get(targetRaw);
    if (!source || !target) continue;

    const label = toNonEmptyString(edgeRecord.type) || toNonEmptyString(edgeRecord.label) || "references";
    const edgeKey = `${source}->${target}:${label}`;
    if (seenEdges.has(edgeKey)) continue;
    seenEdges.add(edgeKey);
    edges.push({ source, target, label });
  }

  return { nodes, edges };
}

function mergeGraphs(
  left: { nodes: GraphNode[]; edges: GraphEdge[] },
  right: { nodes: GraphNode[]; edges: GraphEdge[] },
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const nodes = [...left.nodes, ...right.nodes];
  const seen = new Set<string>();
  const edges: GraphEdge[] = [];
  for (const edge of [...left.edges, ...right.edges]) {
    const key = `${edge.source}->${edge.target}:${edge.label}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push(edge);
  }
  return { nodes, edges };
}

async function listAllAgents(context: PluginContext, companyId: string): Promise<AgentRecord[]> {
  const limit = 250;
  const items: AgentRecord[] = [];
  for (let offset = 0; ; offset += limit) {
    const batch = await context.agents.list({ companyId, limit, offset });
    items.push(...batch);
    if (batch.length < limit) break;
  }
  return items;
}

async function listAllIssues(context: PluginContext, companyId: string): Promise<IssueRecord[]> {
  const limit = 250;
  const items: IssueRecord[] = [];
  for (let offset = 0; ; offset += limit) {
    const batch = await context.issues.list({ companyId, limit, offset });
    items.push(...batch);
    if (batch.length < limit) break;
  }
  return items;
}

async function loadUaKnowledgeGraph(context: PluginContext): Promise<UaKnowledgeGraph | null> {
  const kgPath = resolveUaKnowledgeGraphPath();
  try {
    const content = await fs.readFile(kgPath, "utf8");
    const parsed = JSON.parse(content) as UaKnowledgeGraph;
    return parsed;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes("ENOENT")) {
      context.logger.info("UA knowledge graph not found; rendering agent graph only", { kgPath });
      return null;
    }
    context.logger.warn("Failed to load UA knowledge graph; rendering agent graph only", { kgPath, error: message });
    return null;
  }
}

function mapIssuesByAgent(issues: IssueRecord[]): Map<string, IssueRecord[]> {
  const bucket = new Map<string, IssueRecord[]>();
  for (const issue of issues) {
    if (!issue.assigneeAgentId) continue;
    const list = bucket.get(issue.assigneeAgentId) ?? [];
    list.push(issue);
    bucket.set(issue.assigneeAgentId, list);
  }
  return bucket;
}

function computeFailureStreak(issues: IssueRecord[]): number {
  const ordered = [...issues].sort(issueSortDesc);
  let streak = 0;
  for (const issue of ordered) {
    if (!FAILED_SIGNAL_STATUSES.has(issue.status)) break;
    streak += 1;
  }
  return streak;
}

function computeAgentMetrics(issues: IssueRecord[]): AgentMetrics {
  let open = 0;
  let done = 0;
  let inReview = 0;

  for (const issue of issues) {
    if (issue.status === "done") done += 1;
    if (OPEN_STATUSES.has(issue.status)) open += 1;
    if (issue.status === "in_review") inReview += 1;
  }

  return {
    open,
    done,
    inReview,
    failedStreak: computeFailureStreak(issues),
    assigned: issues.length,
  };
}

function buildHealthCards(agents: AgentRecord[], issuesByAgent: Map<string, IssueRecord[]>): HealthCard[] {
  const totalAgents = agents.length;
  const activeAgents = agents.filter((agent) => ACTIVE_STATUSES.has(agent.status)).length;
  const utilizationScore = totalAgents > 0 ? (activeAgents / totalAgents) * 100 : 0;

  const cards: HealthCard[] = [
    {
      name: "전체 가동률",
      score: clampScore(utilizationScore),
      state: toHealthState(utilizationScore),
      detail: `활성 에이전트 ${activeAgents}/${totalAgents}`,
      delta: {
        diff: activeAgents - (totalAgents - activeAgents),
        direction: activeAgents >= (totalAgents - activeAgents) ? "up" : "down",
      },
    },
  ];

  for (const agent of agents) {
    const assignedIssues = issuesByAgent.get(agent.id) ?? [];
    const metrics = computeAgentMetrics(assignedIssues);

    const ratioScore = metrics.open + metrics.done > 0
      ? (metrics.done / (metrics.done + metrics.open)) * 100
      : ACTIVE_STATUSES.has(agent.status)
        ? 76
        : 58;
    const statusBonus = ACTIVE_STATUSES.has(agent.status) ? 8 : -8;
    const reviewPenalty = metrics.inReview >= 3 ? 10 : 0;
    const failurePenalty = Math.min(36, metrics.failedStreak * 12);
    const score = clampScore(ratioScore + statusBonus - reviewPenalty - failurePenalty);
    const diff = metrics.done - metrics.open;

    cards.push({
      name: agent.name,
      score,
      state: toHealthState(score),
      detail: `완료 ${metrics.done} · 미완료 ${metrics.open} · in_review ${metrics.inReview} · 연속 실패 ${metrics.failedStreak}`,
      delta: {
        diff,
        direction: diff === 0 ? "flat" : diff > 0 ? "up" : "down",
      },
    });
  }

  return cards;
}

function buildMetaQuestions(agents: AgentRecord[], issuesByAgent: Map<string, IssueRecord[]>, now: Date): MetaQuestion[] {
  const questions: MetaQuestion[] = [];
  const weekAgo = now.getTime() - (7 * DAY_MS);

  const idleAgents: string[] = [];
  for (const agent of agents) {
    const assigned = issuesByAgent.get(agent.id) ?? [];
    const touchedInWeek = assigned.some((issue) => {
      const touched = touchedAt(issue);
      return Boolean(touched && touched.getTime() >= weekAgo);
    });
    if (!touchedInWeek) idleAgents.push(agent.name);
  }
  if (idleAgents.length > 0) {
    questions.push({
      text: `유휴 상태: 최근 7일간 이슈 흔적이 없는 에이전트가 있다 (${idleAgents.join(", ")}).`,
      actionHint: "백로그 분배를 다시 하고, 주 1회 이상 최소 실행 단위를 배정하세요.",
    });
  }

  const issueLoad = agents
    .map((agent) => ({ name: agent.name, count: (issuesByAgent.get(agent.id) ?? []).length }))
    .filter((item) => item.count > 0);
  const totalAssigned = issueLoad.reduce((sum, item) => sum + item.count, 0);
  const skewed = issueLoad
    .filter((item) => totalAssigned > 0 && (item.count / totalAssigned) >= 0.3)
    .map((item) => `${item.name}(${Math.round((item.count / totalAssigned) * 100)}%)`);
  if (skewed.length > 0) {
    questions.push({
      text: `업무 편중: 특정 에이전트 이슈 비중이 30%를 넘는다 (${skewed.join(", ")}).`,
      actionHint: "업무를 기능 단위로 쪼개고 보조 에이전트에 재위임해 병렬 처리율을 높이세요.",
    });
  }

  const reviewBacklog = agents
    .map((agent) => {
      const inReview = (issuesByAgent.get(agent.id) ?? []).filter((issue) => issue.status === "in_review").length;
      return { name: agent.name, inReview };
    })
    .filter((item) => item.inReview >= 3)
    .map((item) => `${item.name}(${item.inReview}건)`);
  if (reviewBacklog.length > 0) {
    questions.push({
      text: `검수 병목: in_review 적체가 3건 이상인 에이전트가 있다 (${reviewBacklog.join(", ")}).`,
      actionHint: "검수자 교대 슬롯을 만들고, 리뷰 SLA를 정해 오래된 검수부터 처리하세요.",
    });
  }

  const openBacklog = agents
    .map((agent) => {
      const metrics = computeAgentMetrics(issuesByAgent.get(agent.id) ?? []);
      return { name: agent.name, open: metrics.open, done: metrics.done };
    })
    .filter((item) => item.open > item.done)
    .map((item) => `${item.name}(open ${item.open} > done ${item.done})`);
  if (openBacklog.length > 0) {
    questions.push({
      text: `미처리 적체: open 이슈가 done 보다 많은 에이전트가 있다 (${openBacklog.join(", ")}).`,
      actionHint: "WIP 상한을 도입하고, 신규 착수 전에 열린 이슈를 먼저 정리하세요.",
    });
  }

  if (questions.length === 0) {
    questions.push({
      text: "현재 구조는 안정적이다. 다음 스프린트에서 어떤 실험으로 throughput을 더 높일 수 있을까?",
      actionHint: "한 번에 1개 개선 가설만 선택해 1주일 후 지표(완료율/리드타임)로 검증하세요.",
    });
  }

  return questions;
}

function toAgentIssueBrief(issue: IssueRecord): AgentIssueBrief {
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
    updatedAt: toIsoString(issue.updatedAt),
  };
}

function buildAgentDetailSnapshot(
  agents: AgentRecord[],
  issues: IssueRecord[],
  agentId: string,
): AgentDetailSnapshot | null {
  if (!agentId) return null;
  const agent = agents.find((entry) => entry.id === agentId);
  if (!agent) return null;

  const recentIssues = issues
    .filter((issue) => issue.assigneeAgentId === agent.id)
    .sort(issueSortDesc)
    .slice(0, 5)
    .map(toAgentIssueBrief);

  return {
    agentId: agent.id,
    name: agent.name,
    status: agent.status,
    role: agent.role,
    recentIssues,
  };
}

export async function buildGardenSnapshot(
  context: PluginContext,
  input: { companyId: string; now?: Date },
): Promise<GardenSnapshot> {
  const now = input.now ?? new Date();
  const [agents, issues, knowledgeGraph] = await Promise.all([
    listAllAgents(context, input.companyId),
    listAllIssues(context, input.companyId),
    loadUaKnowledgeGraph(context),
  ]);

  const issuesByAgent = mapIssuesByAgent(issues);
  const agentGraph = buildGraph(agents);
  const codeGraph = buildCodeGraph(knowledgeGraph);
  const agentsById = new Map(agents.map((agent) => [agent.id, { id: agent.id, name: agent.name }] as const));
  const missionIssueGraph = await buildMissionIssueGraph({
    issues,
    agentsById,
    loadComments: async (issueId) => await context.issues.listComments(issueId, input.companyId),
  });
  const graph = mergeGraphs(mergeGraphs(agentGraph, codeGraph), missionIssueGraph.graph);
  const cards = buildHealthCards(agents, issuesByAgent);
  const questions = buildMetaQuestions(agents, issuesByAgent, now);
  const missionIssueCount = missionIssueGraph.graph.nodes.filter((node) => node.kind === "issue").length;
  const missionIssueEdgeCount = missionIssueGraph.graph.edges.length;

  return {
    meta: {
      generatedAt: now.toISOString(),
      agentCount: agents.length,
      issueCount: issues.length,
      missionIssueCount,
      missionSeedCount: missionIssueGraph.seedIssueIds.length,
      missionIssueEdgeCount,
    },
    graph,
    cards,
    questions,
  };
}

const plugin = definePlugin({
  async setup(context) {
    context.data.register("system-garden-snapshot", async (params) => {
      const companyId = getCompanyId(params);
      return await buildGardenSnapshot(context, { companyId });
    });

    context.data.register("system-garden-agent-detail", async (params) => {
      const companyId = getCompanyId(params);
      const agentId = getAgentId(params);
      if (!companyId || !agentId) return null;

      const [agents, issues] = await Promise.all([
        context.agents.list({ companyId, limit: 300, offset: 0 }),
        context.issues.list({ companyId, limit: 400, offset: 0 }),
      ]);

      return buildAgentDetailSnapshot(agents, issues, agentId);
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: `${PLUGIN_DISPLAY_NAME} worker ready`,
      details: {
        health: "garden-snapshot-enabled",
      },
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
