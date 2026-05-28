import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  BRIDGE_DIRECTIONS,
  DATA_KEYS,
  JOB_KEYS,
  PLUGIN_ID,
  SYNC_STAMP_TTL_MS,
} from "./constants.js";
import {
  asRecord,
  asString,
  asStringArray,
  canPropagateLocalToRemote,
  hasActiveSyncStamp,
  isEventProcessed,
  listBridgeLinksByCompany,
  listBridgeLinksForLocalIssue,
  makeSyncStampExternalId,
  markEventProcessed,
  normalizeDirection,
  touchBridgeSyncMeta,
  upsertBridgePair,
  upsertSyncStamp,
  type BridgeLinkRecord,
} from "./store.js";

type JsonRecord = Record<string, unknown>;
type IssueRecord = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];
type CompanyRecord = Awaited<ReturnType<PluginContext["companies"]["list"]>>[number];
type ProjectRecord = Awaited<ReturnType<PluginContext["projects"]["list"]>>[number];
type IssuePatch = Parameters<PluginContext["issues"]["update"]>[1];
type BridgeConfigRecord = Awaited<ReturnType<PluginContext["config"]["get"]>>;

type IssueSnapshot = {
  id: string;
  identifier: string | null;
  title: string;
  status: string;
};

type BridgePluginConfig = {
  providerCompanyId: string;
  providerCompanyName: string;
  providerProjectId: string;
  providerProjectName: string;
  requesterLabelNames: string[];
  requesterTitlePrefixes: string[];
  autoCreateMirrorIssue: boolean;
  workflowTriggerLabel: string;
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
  issue: IssueSnapshot | null;
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

type IssueCreatedRefs = {
  companyId: string;
  issueId: string;
  title: string;
  description: string;
  labels: string[];
};

const DEFAULT_REQUESTER_LABEL = "유지보수";
const MIRROR_TITLE_PREFIX = "[유지보수]";
const TELEGRAM_API_BASE = "https://api.telegram.org";

function getNestedString(record: JsonRecord, ...path: string[]): string {
  let cursor: unknown = record;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as JsonRecord)[key];
  }

  return asString(cursor);
}

function asBoolean(value: unknown, fallback = false): boolean {
  if (typeof value === "boolean") {
    return value;
  }

  return fallback;
}

function getCompanyIdFromParams(params: JsonRecord): string {
  return asString(params.companyId) || asString(params.localCompanyId);
}

function registerDataHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const dataClient = ctx.data as PluginContext["data"] & {
    handle?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof dataClient.handle === "function") {
    dataClient.handle(key, handler);
    return;
  }

  if (typeof dataClient.register === "function") {
    dataClient.register(key, handler);
    return;
  }

  throw new Error("Plugin data client does not support handler registration");
}

function registerActionHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const actionClient = ctx.actions as PluginContext["actions"] & {
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof actionClient.register === "function") {
    actionClient.register(key, handler);
    return;
  }

  throw new Error("Plugin action client does not support handler registration");
}

function toIssueSnapshot(issue: IssueRecord): IssueSnapshot {
  return {
    id: issue.id,
    identifier: issue.identifier ?? null,
    title: issue.title,
    status: issue.status,
  };
}

async function listIssues(ctx: PluginContext, companyId: string): Promise<IssueRecord[]> {
  return await ctx.issues.list({ companyId, limit: 500, offset: 0 });
}

async function findIssueByIdOrIdentifier(
  ctx: PluginContext,
  companyId: string,
  issueKey: string,
): Promise<IssueRecord | null> {
  const issueId = asString(issueKey);
  if (!issueId) {
    return null;
  }

  const issues = await listIssues(ctx, companyId);
  return issues.find((issue) => issue.id === issueId || issue.identifier === issueId) ?? null;
}

async function listCompanies(ctx: PluginContext): Promise<CompanyRecord[]> {
  return await ctx.companies.list({ limit: 500, offset: 0 });
}

async function listProjects(ctx: PluginContext, companyId: string): Promise<ProjectRecord[]> {
  if (!companyId) {
    return [];
  }
  return await ctx.projects.list({ companyId });
}

function normalizeName(value: string): string {
  return value.trim().toLowerCase();
}

function getLabelNames(rawLabels: unknown): string[] {
  if (!Array.isArray(rawLabels)) {
    return [];
  }

  const names: string[] = [];
  for (const item of rawLabels) {
    if (typeof item === "string" && item.trim()) {
      names.push(item.trim());
      continue;
    }

    if (item && typeof item === "object") {
      const labelRecord = item as JsonRecord;
      const name = asString(labelRecord.name) || asString(labelRecord.label);
      if (name) {
        names.push(name);
      }
    }
  }

  return names;
}

function isMatchingLabel(labels: string[], expectedLabelName: string): boolean {
  const expected = normalizeName(expectedLabelName);
  if (!expected) {
    return false;
  }

  return labels.some((label) => normalizeName(label) === expected);
}

function firstLine(value: string): string {
  return value.split("\n")[0]?.trim() || value.trim();
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatBridgeFailureComment(
  errorMessage: string,
  providerCompany: Pick<CompanyRecord, "id" | "name"> | null,
): string {
  const timestamp = new Date().toISOString();
  const target = providerCompany?.name || providerCompany?.id || "unknown";
  return [
    `⚠️ Bridge 실패: ${firstLine(errorMessage)}`,
    `- 시각: ${timestamp}`,
    `- 대상: ${target}`,
    "수동 handoff 필요",
  ].join("\n");
}

async function sendBridgeFailureTelegram(
  issueIdentifier: string,
  errorMessage: string,
): Promise<void> {
  const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
  const chatId = process.env.TELEGRAM_CHAT_ID?.trim();
  if (!botToken || !chatId) {
    return;
  }

  const response = await fetch(`${TELEGRAM_API_BASE}/bot${botToken}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: [
        "⚠️ Bridge 실패",
        `이슈: ${issueIdentifier}`,
        `에러: ${firstLine(errorMessage)}`,
        "→ 수동 확인 필요",
      ].join("\n"),
    }),
  });

  if (!response.ok) {
    throw new Error(`telegram send failed: HTTP ${response.status}`);
  }
}

function hasTitlePrefix(title: string, expectedPrefix: string): boolean {
  const normalizedTitle = title.trim();
  const normalizedPrefix = expectedPrefix.trim();
  if (!normalizedTitle || !normalizedPrefix) {
    return false;
  }

  return normalizedTitle.startsWith(`[${normalizedPrefix}]`);
}

function normalizeAliasList(value: unknown): string[] {
  const items = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : [];
  const cleaned = items
    .map((item) => typeof item === "string" ? item.trim() : "")
    .filter(Boolean);
  return [...new Set(cleaned)];
}

function hasAnyMatchingLabel(labels: string[], expectedLabelNames: string[]): boolean {
  return expectedLabelNames.some((label) => isMatchingLabel(labels, label));
}

function hasAnyTitlePrefix(title: string, expectedPrefixes: string[]): boolean {
  return expectedPrefixes.some((prefix) => hasTitlePrefix(title, prefix));
}

function matchesRequesterSignal(
  title: string,
  labels: string[],
  config: BridgePluginConfig,
): boolean {
  return Boolean(title) && (
    hasAnyMatchingLabel(labels, config.requesterLabelNames) ||
    hasAnyTitlePrefix(title, config.requesterTitlePrefixes)
  );
}

async function getBridgeConfig(ctx: PluginContext): Promise<BridgePluginConfig> {
  const raw = asRecord(await ctx.config.get() as BridgeConfigRecord);
  const legacyLabelName = asString(raw.requesterLabelName);
  const requesterLabelNames = normalizeAliasList(raw.requesterLabelNames);
  const requesterTitlePrefixes = normalizeAliasList(raw.requesterTitlePrefixes);
  if (requesterLabelNames.length === 0 && legacyLabelName) {
    requesterLabelNames.push(legacyLabelName);
  }
  if (requesterTitlePrefixes.length === 0 && legacyLabelName) {
    requesterTitlePrefixes.push(legacyLabelName);
  }
  if (requesterLabelNames.length === 0) {
    requesterLabelNames.push(DEFAULT_REQUESTER_LABEL);
  }
  if (requesterTitlePrefixes.length === 0) {
    requesterTitlePrefixes.push(DEFAULT_REQUESTER_LABEL);
  }

  const companies = await listCompanies(ctx);
  const configuredCompanyId = asString(raw.providerCompanyId);
  const configuredCompanyName = asString(raw.providerCompanyName);
  let providerCompany: CompanyRecord | null = null;
  if (configuredCompanyId) {
    providerCompany = companies.find((company) => company.id === configuredCompanyId) ?? null;
  }
  if (!providerCompany && configuredCompanyName) {
    providerCompany = companies.find((company) => company.name === configuredCompanyName)
      ?? companies.find((company) => normalizeName(company.name) === normalizeName(configuredCompanyName))
      ?? null;
  }

  const configuredProjectId = asString(raw.providerProjectId);
  const configuredProjectName = asString(raw.providerProjectName);
  const providerProjects = providerCompany ? await listProjects(ctx, providerCompany.id) : [];
  let providerProject: ProjectRecord | null = null;
  if (configuredProjectId) {
    providerProject = providerProjects.find((project) => project.id === configuredProjectId) ?? null;
  }
  if (!providerProject && configuredProjectName) {
    providerProject = providerProjects.find((project) => project.name === configuredProjectName) ?? null;
  }

  return {
    providerCompanyId: providerCompany?.id ?? configuredCompanyId,
    providerCompanyName: providerCompany?.name ?? configuredCompanyName,
    providerProjectId: providerProject?.id ?? configuredProjectId,
    providerProjectName: providerProject?.name ?? configuredProjectName,
    requesterLabelNames,
    requesterTitlePrefixes,
    autoCreateMirrorIssue: asBoolean(raw.autoCreateMirrorIssue, true),
    workflowTriggerLabel: asString(raw.workflowTriggerLabel),
  };
}

async function findCompanyByName(ctx: PluginContext, name: string): Promise<CompanyRecord | null> {
  const providerName = asString(name);
  if (!providerName) {
    return null;
  }

  const companies = await listCompanies(ctx);
  const exact = companies.find((company) => company.name === providerName);
  if (exact) {
    return exact;
  }

  const normalizedName = normalizeName(providerName);
  return companies.find((company) => normalizeName(company.name) === normalizedName) ?? null;
}

async function resolveProviderCompany(ctx: PluginContext, config: BridgePluginConfig): Promise<CompanyRecord | null> {
  const companies = await listCompanies(ctx);
  if (config.providerCompanyId) {
    const byId = companies.find((company) => company.id === config.providerCompanyId);
    if (byId) return byId;
  }
  if (!config.providerCompanyName) {
    return null;
  }
  const exact = companies.find((company) => company.name === config.providerCompanyName);
  if (exact) return exact;
  return companies.find((company) => normalizeName(company.name) === normalizeName(config.providerCompanyName)) ?? null;
}

async function recordBridgeFailure(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  issueIdentifier: string,
  providerCompany: Pick<CompanyRecord, "id" | "name"> | null,
  error: unknown,
): Promise<void> {
  const errorMessage = summarizeError(error);
  const failureComment = formatBridgeFailureComment(errorMessage, providerCompany);

  try {
    await ctx.issues.createComment(issueId, failureComment, companyId);
  } catch (commentError) {
    ctx.logger.error("Failed to record bridge failure comment", {
      localCompanyId: companyId,
      localIssueId: issueId,
      error: summarizeError(commentError),
    });
  }

  try {
    await sendBridgeFailureTelegram(issueIdentifier, errorMessage);
  } catch (telegramError) {
    ctx.logger.warn("Failed to send bridge failure telegram", {
      localCompanyId: companyId,
      localIssueId: issueId,
      error: summarizeError(telegramError),
    });
  }
}

async function ensureMirrorIssue(
  ctx: PluginContext,
  sourceIssue: IssueRecord,
  config: BridgePluginConfig,
): Promise<"created" | "already-linked" | "not-matched" | "skipped-provider"> {
  const sourceIssueId = sourceIssue.id;
  const sourceTitle = sourceIssue.title;
  const sourceDescription = asString((sourceIssue as unknown as JsonRecord | undefined)?.description);
  const sourceLabels = getLabelNames((sourceIssue as unknown as JsonRecord | undefined)?.labels);

  if (!matchesRequesterSignal(sourceTitle, sourceLabels, config)) {
    return "not-matched";
  }

  const providerCompany = await resolveProviderCompany(ctx, config);
  if (!providerCompany) {
    throw new Error(`Provider company is not configured or not found: ${config.providerCompanyName || config.providerCompanyId || "(empty)"}`);
  }

  if (providerCompany.id === sourceIssue.companyId) {
    ctx.logger.warn("Provider company equals requester company. Auto mirror skipped.", {
      companyId: sourceIssue.companyId,
      issueId: sourceIssueId,
      providerCompanyId: providerCompany.id,
    });
    return "skipped-provider";
  }

  const existingLinks = await listBridgeLinksForLocalIssue(ctx, sourceIssue.companyId, sourceIssueId);
  const alreadyLinked = existingLinks.some((link) => link.data.remoteCompanyId === providerCompany.id);
  if (alreadyLinked) {
    return "already-linked";
  }

  const workflowLabel = typeof config.workflowTriggerLabel === "string" && config.workflowTriggerLabel.trim()
    ? config.workflowTriggerLabel.trim()
    : "";
  const mirrorTitle = workflowLabel
    ? `[${workflowLabel}] ${MIRROR_TITLE_PREFIX} ${sourceTitle}`
    : `${MIRROR_TITLE_PREFIX} ${sourceTitle}`;

  const mirrorCreateParams: Record<string, unknown> = {
    companyId: providerCompany.id,
    title: mirrorTitle,
    description: sourceDescription,
    status: "todo",
  };
  if (workflowLabel) {
    mirrorCreateParams.labels = [workflowLabel];
  }

  if (config.providerProjectId || config.providerProjectName) {
    const providerProjects = await ctx.projects.list({ companyId: providerCompany.id });
    const targetProject = config.providerProjectId
      ? providerProjects.find((project) => project.id === config.providerProjectId)
      : providerProjects.find((project) => project.name === config.providerProjectName);
    if (targetProject) {
      mirrorCreateParams.projectId = targetProject.id;
    }
  }

  const providerCeoAgentId = await resolveCompanyCeoAgentId(ctx, providerCompany.id);
  if (providerCeoAgentId) {
    mirrorCreateParams.assigneeAgentId = providerCeoAgentId;
  }

  const mirrorIssue = await ctx.issues.create(
    mirrorCreateParams as Parameters<typeof ctx.issues.create>[0],
  );

  await upsertBridgePair(ctx, {
    localCompanyId: sourceIssue.companyId,
    localIssueId: sourceIssueId,
    remoteCompanyId: providerCompany.id,
    remoteIssueId: mirrorIssue.id,
    direction: BRIDGE_DIRECTIONS.twoWay,
    createdBy: "service-request-bridge-auto",
  });

  await ctx.issues.update(
    sourceIssueId,
    {
      status: "blocked",
      assigneeAgentId: null,
    } as IssuePatch,
    sourceIssue.companyId,
  );

  const handoffComment = [
    `보수팀으로 유지보수 handoff 완료: ${mirrorIssue.identifier ?? mirrorIssue.id}`,
    `- 대상 회사: ${providerCompany.name}`,
    providerCeoAgentId ? "- 처리 방식: 보수팀 CEO가 담당 할당 및 완료 보고를 관리" : "- 처리 방식: 보수팀에서 후속 triage 필요",
  ].join("\n");

  await ctx.issues.createComment(sourceIssueId, handoffComment, sourceIssue.companyId);

  ctx.logger.info("Auto-created mirror issue and bridge link", {
    localCompanyId: sourceIssue.companyId,
    localIssueId: sourceIssueId,
    providerCompanyId: providerCompany.id,
    remoteIssueId: mirrorIssue.id,
  });

  return "created";
}

async function resolveCompanyCeoAgentId(
  ctx: PluginContext,
  companyId: string,
): Promise<string> {
  if (!companyId) {
    return "";
  }

  const agents = await ctx.agents.list({ companyId, limit: 200, offset: 0 });
  const ceo = agents.find((agent) => normalizeName(asString(agent.role)) === "ceo")
    ?? agents.find((agent) => normalizeName(asString(agent.title)) === "ceo");
  return ceo?.id ?? "";
}

function companyNameMap(companies: CompanyRecord[]): Map<string, string> {
  return new Map(companies.map((company) => [company.id, company.name]));
}

function dashboardStatusBucket(status: string): keyof DashboardWidgetSnapshot["statusCounts"] {
  const normalized = normalizeName(status);

  if (normalized === "done" || normalized === "resolved" || normalized === "closed" || normalized === "cancelled") {
    return "resolved";
  }

  if (normalized === "in_progress" || normalized === "in_review" || normalized === "review") {
    return "inProgress";
  }

  if (normalized === "backlog" || normalized === "todo" || normalized === "open" || normalized === "blocked") {
    return "open";
  }

  return "unknown";
}

async function buildDashboardWidgetSnapshot(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<DashboardWidgetSnapshot> {
  const companyId = getCompanyIdFromParams(params);
  if (!companyId) {
    return {
      companyId: "",
      generatedAt: new Date().toISOString(),
      totalActiveLinks: 0,
      statusCounts: {
        open: 0,
        inProgress: 0,
        resolved: 0,
        unknown: 0,
      },
    };
  }

  const [issues, links] = await Promise.all([
    listIssues(ctx, companyId),
    listBridgeLinksByCompany(ctx, companyId),
  ]);
  const issueStatusMap = new Map<string, string>(issues.map((issue) => [issue.id, issue.status]));

  const statusCounts: DashboardWidgetSnapshot["statusCounts"] = {
    open: 0,
    inProgress: 0,
    resolved: 0,
    unknown: 0,
  };

  for (const link of links) {
    const localIssueStatus = issueStatusMap.get(link.data.localIssueId) ?? "unknown";
    statusCounts[dashboardStatusBucket(localIssueStatus)] += 1;
  }

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    totalActiveLinks: links.length,
    statusCounts,
  };
}

async function buildListTabSnapshot(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<ListTabSnapshot> {
  const companyId = getCompanyIdFromParams(params);
  if (!companyId) {
    return {
      companyId: "",
      generatedAt: new Date().toISOString(),
      totals: {
        issues: 0,
        linked: 0,
        unlinked: 0,
      },
      items: [],
    };
  }

  const requestedIssueIds = new Set(asStringArray(params.issueIds));
  const [issues, links, companies] = await Promise.all([
    listIssues(ctx, companyId),
    listBridgeLinksByCompany(ctx, companyId),
    listCompanies(ctx),
  ]);

  const visibleIssues = requestedIssueIds.size > 0
    ? issues.filter((issue) => requestedIssueIds.has(issue.id) || (issue.identifier ? requestedIssueIds.has(issue.identifier) : false))
    : issues;

  const byLocalIssue = new Map<string, BridgeLinkRecord[]>();
  for (const link of links) {
    const bucket = byLocalIssue.get(link.data.localIssueId);
    if (bucket) {
      bucket.push(link);
    } else {
      byLocalIssue.set(link.data.localIssueId, [link]);
    }
  }

  const names = companyNameMap(companies);
  const remoteIssueCache = new Map<string, IssueSnapshot | null>();

  async function resolveRemoteIssue(company: string, issueId: string): Promise<IssueSnapshot | null> {
    const key = `${company}:${issueId}`;
    if (remoteIssueCache.has(key)) {
      return remoteIssueCache.get(key) ?? null;
    }

    const issue = await findIssueByIdOrIdentifier(ctx, company, issueId);
    const snapshot = issue ? toIssueSnapshot(issue) : null;
    remoteIssueCache.set(key, snapshot);
    return snapshot;
  }

  const items: ListTabSnapshot["items"] = [];
  for (const issue of visibleIssues) {
    const mapped = byLocalIssue.get(issue.id) ?? [];
    const linkRows: ListTabSnapshot["items"][number]["links"] = [];

    for (const link of mapped) {
      const remote = await resolveRemoteIssue(link.data.remoteCompanyId, link.data.remoteIssueId);

      linkRows.push({
        bridgeId: link.id,
        direction: link.data.direction,
        remoteCompanyId: link.data.remoteCompanyId,
        remoteCompanyName: names.get(link.data.remoteCompanyId) ?? null,
        remoteIssueId: link.data.remoteIssueId,
        remoteIdentifier: remote?.identifier ?? null,
        remoteTitle: remote?.title ?? null,
        remoteStatus: remote?.status ?? null,
      });
    }

    items.push({
      issueId: issue.id,
      identifier: issue.identifier ?? null,
      title: issue.title,
      status: issue.status,
      linkCount: linkRows.length,
      links: linkRows,
    });
  }

  items.sort((left, right) => {
    if (left.linkCount !== right.linkCount) {
      return right.linkCount - left.linkCount;
    }
    return left.title.localeCompare(right.title);
  });

  const linked = items.filter((item) => item.linkCount > 0).length;

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    totals: {
      issues: items.length,
      linked,
      unlinked: Math.max(items.length - linked, 0),
    },
    items,
  };
}

async function buildDetailTabSnapshot(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<DetailTabSnapshot> {
  const companyId = getCompanyIdFromParams(params);
  const issueId = asString(params.issueId) || asString(params.localIssueId);

  if (!companyId) {
    return {
      companyId: "",
      generatedAt: new Date().toISOString(),
      issue: null,
      links: [],
      remoteCompanies: [],
    };
  }

  const [issue, links, companies] = await Promise.all([
    issueId ? findIssueByIdOrIdentifier(ctx, companyId, issueId) : Promise.resolve(null),
    issueId ? listBridgeLinksForLocalIssue(ctx, companyId, issueId) : Promise.resolve([]),
    listCompanies(ctx),
  ]);

  const names = companyNameMap(companies);
  const remoteIssueCache = new Map<string, IssueSnapshot | null>();

  async function resolveRemoteIssue(company: string, remoteIssueId: string): Promise<IssueSnapshot | null> {
    const key = `${company}:${remoteIssueId}`;
    if (remoteIssueCache.has(key)) {
      return remoteIssueCache.get(key) ?? null;
    }

    const remoteIssue = await findIssueByIdOrIdentifier(ctx, company, remoteIssueId);
    const snapshot = remoteIssue ? toIssueSnapshot(remoteIssue) : null;
    remoteIssueCache.set(key, snapshot);
    return snapshot;
  }

  const rows: DetailTabSnapshot["links"] = [];
  for (const link of links) {
    const remote = await resolveRemoteIssue(link.data.remoteCompanyId, link.data.remoteIssueId);
    rows.push({
      bridgeId: link.id,
      direction: link.data.direction,
      remoteCompanyId: link.data.remoteCompanyId,
      remoteCompanyName: names.get(link.data.remoteCompanyId) ?? null,
      remoteIssueId: link.data.remoteIssueId,
      remoteIdentifier: remote?.identifier ?? null,
      remoteTitle: remote?.title ?? null,
      remoteStatus: remote?.status ?? null,
      updatedAt: link.data.updatedAt,
      lastSyncedAt: link.data.lastSyncedAt,
      lastSyncedStatus: link.data.lastSyncedStatus,
    });
  }

  rows.sort((left, right) => left.remoteCompanyId.localeCompare(right.remoteCompanyId) || left.remoteIssueId.localeCompare(right.remoteIssueId));

  return {
    companyId,
    generatedAt: new Date().toISOString(),
    issue: issue ? toIssueSnapshot(issue) : null,
    links: rows,
    remoteCompanies: companies
      .filter((company) => company.id !== companyId)
      .map((company) => ({ id: company.id, name: company.name }))
      .sort((left, right) => left.name.localeCompare(right.name)),
  };
}

async function createBridgeLinkFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<{ id: string; mirrorId: string; direction: string }> {
  const localCompanyId = getCompanyIdFromParams(params);
  const remoteCompanyId = asString(params.remoteCompanyId);
  const localIssueKey = asString(params.localIssueId);
  const remoteIssueKey = asString(params.remoteIssueId);
  const direction = normalizeDirection(params.direction);
  const createdBy = asString(params.createdBy) || "service-request-bridge-ui";

  if (!localCompanyId || !remoteCompanyId || !localIssueKey || !remoteIssueKey) {
    throw new Error("create-link requires companyId, remoteCompanyId, localIssueId, remoteIssueId");
  }

  if (localCompanyId === remoteCompanyId) {
    throw new Error("Bridge requires two different companies");
  }

  const [localIssue, remoteIssue] = await Promise.all([
    findIssueByIdOrIdentifier(ctx, localCompanyId, localIssueKey),
    findIssueByIdOrIdentifier(ctx, remoteCompanyId, remoteIssueKey),
  ]);

  if (!localIssue) {
    throw new Error(`Local issue not found: ${localIssueKey}`);
  }

  if (!remoteIssue) {
    throw new Error(`Remote issue not found: ${remoteIssueKey}`);
  }

  const result = await upsertBridgePair(ctx, {
    localCompanyId,
    localIssueId: localIssue.id,
    remoteCompanyId,
    remoteIssueId: remoteIssue.id,
    direction,
    createdBy,
  });

  return {
    id: result.local.id,
    mirrorId: result.mirror.id,
    direction,
  };
}

function extractIssueCreatedRefs(event: PluginEvent): IssueCreatedRefs {
  const payload = asRecord(event.payload);
  const issuePayload = asRecord(payload.issue);

  const companyId = asString(payload.companyId)
    || asString(payload.company_id)
    || asString(issuePayload.companyId)
    || asString(issuePayload.company_id)
    || asString((event as unknown as JsonRecord).companyId)
    || asString((event as unknown as JsonRecord).scopeId);

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || asString(issuePayload.id)
    || (event.entityType === "issue" ? asString(event.entityId) : "");

  const title = asString(payload.title)
    || asString(issuePayload.title);

  const description = asString(payload.description)
    || asString(issuePayload.description);

  const labels = [
    ...getLabelNames(payload.labels),
    ...getLabelNames(issuePayload.labels),
  ];

  return {
    companyId,
    issueId,
    title,
    description,
    labels,
  };
}

function extractIssueUpdatedRefs(event: PluginEvent): {
  companyId: string;
  issueId: string;
  status: string;
} {
  const payload = asRecord(event.payload);

  const companyId = asString(payload.companyId)
    || asString(payload.company_id)
    || getNestedString(payload, "issue", "companyId")
    || getNestedString(payload, "issue", "company_id")
    || getNestedString(payload, "context", "companyId")
    || getNestedString(payload, "context", "company_id")
    || asString((event as unknown as JsonRecord).companyId)
    || asString((event as unknown as JsonRecord).scopeId);

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || getNestedString(payload, "issue", "id")
    || getNestedString(payload, "context", "issueId")
    || getNestedString(payload, "context", "issue", "id")
    || (event.entityType === "issue" ? asString(event.entityId) : "");

  const status = asString(payload.status)
    || getNestedString(payload, "issue", "status")
    || getNestedString(payload, "changes", "status", "to");

  return {
    companyId,
    issueId,
    status,
  };
}

async function resolveCurrentIssueStatus(
  ctx: PluginContext,
  companyId: string,
  issueId: string,
  fallbackStatus: string,
): Promise<string> {
  if (fallbackStatus) {
    return fallbackStatus;
  }

  const issue = await findIssueByIdOrIdentifier(ctx, companyId, issueId);
  return issue?.status ?? "";
}

async function syncLinkedIssueStatus(
  ctx: PluginContext,
  source: {
    companyId: string;
    issueId: string;
    status: string;
  },
  link: BridgeLinkRecord,
): Promise<void> {
  const sourceStatus = asString(source.status);
  if (!sourceStatus) {
    return;
  }

  const routeStampKey = makeSyncStampExternalId({
    localIssueId: link.data.localIssueId,
    remoteCompanyId: link.data.remoteCompanyId,
    remoteIssueId: link.data.remoteIssueId,
    status: sourceStatus,
  });

  const shouldSkip = await hasActiveSyncStamp(ctx, source.companyId, routeStampKey, SYNC_STAMP_TTL_MS);
  if (shouldSkip) {
    ctx.logger.info("Skipped bridge sync due to active sync stamp", {
      companyId: source.companyId,
      issueId: source.issueId,
      remoteCompanyId: link.data.remoteCompanyId,
      remoteIssueId: link.data.remoteIssueId,
      status: sourceStatus,
    });
    return;
  }

  const remoteIssue = await findIssueByIdOrIdentifier(
    ctx,
    link.data.remoteCompanyId,
    link.data.remoteIssueId,
  );

  if (!remoteIssue) {
    ctx.logger.warn("Bridge target issue not found", {
      companyId: source.companyId,
      issueId: source.issueId,
      remoteCompanyId: link.data.remoteCompanyId,
      remoteIssueId: link.data.remoteIssueId,
    });
    return;
  }

  if (remoteIssue.status !== sourceStatus) {
    await ctx.issues.update(
      remoteIssue.id,
      { status: sourceStatus } as IssuePatch,
      link.data.remoteCompanyId,
    );

    ctx.logger.info("Bridge synchronized issue status", {
      fromCompanyId: source.companyId,
      fromIssueId: source.issueId,
      toCompanyId: link.data.remoteCompanyId,
      toIssueId: remoteIssue.id,
      status: sourceStatus,
    });
  }

  const stampCreatedAt = new Date().toISOString();

  const reverseStampKey = makeSyncStampExternalId({
    localIssueId: remoteIssue.id,
    remoteCompanyId: source.companyId,
    remoteIssueId: source.issueId,
    status: sourceStatus,
  });

  await upsertSyncStamp(ctx, link.data.remoteCompanyId, reverseStampKey, {
    localIssueId: remoteIssue.id,
    remoteCompanyId: source.companyId,
    remoteIssueId: source.issueId,
    status: sourceStatus,
    createdAt: stampCreatedAt,
  });

  await touchBridgeSyncMeta(ctx, link, {
    syncedAt: stampCreatedAt,
    status: sourceStatus,
    sourceIssueId: source.issueId,
  });
}

async function handleIssueCreated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const refs = extractIssueCreatedRefs(event);
  if (!refs.companyId || !refs.issueId) {
    return;
  }

  const eventId = asString(event.eventId);
  if (eventId) {
    const processed = await isEventProcessed(ctx, refs.companyId, eventId);
    if (processed) {
      return;
    }
  }

  const config = await getBridgeConfig(ctx);
  if (!config.autoCreateMirrorIssue) {
    if (eventId) {
      await markEventProcessed(ctx, refs.companyId, eventId);
    }
    return;
  }

  const sourceIssue = await findIssueByIdOrIdentifier(ctx, refs.companyId, refs.issueId);
  const sourceIssueId = sourceIssue?.id ?? refs.issueId;
  const sourceTitle = sourceIssue?.title ?? refs.title;
  const sourceDescription = asString((sourceIssue as unknown as JsonRecord | undefined)?.description) || refs.description;
  const sourceLabels = [
    ...getLabelNames((sourceIssue as unknown as JsonRecord | undefined)?.labels),
    ...refs.labels,
  ];

  if (!matchesRequesterSignal(sourceTitle, sourceLabels, config)) {
    if (eventId) {
      await markEventProcessed(ctx, refs.companyId, eventId);
    }
    return;
  }

  try {
    await ensureMirrorIssue(ctx, sourceIssue as IssueRecord, config);
    if (eventId) {
      await markEventProcessed(ctx, refs.companyId, eventId);
    }
  } catch (error) {
    const providerCompany = await resolveProviderCompany(ctx, config);
    await recordBridgeFailure(
      ctx,
      refs.companyId,
      sourceIssueId,
      sourceIssue?.identifier ?? refs.issueId,
      providerCompany,
      error,
    );

    ctx.logger.error("Auto mirror issue creation failed", {
      localCompanyId: refs.companyId,
      localIssueId: sourceIssueId,
      providerCompanyId: providerCompany?.id ?? null,
      error: summarizeError(error),
    });

    if (eventId) {
      await markEventProcessed(ctx, refs.companyId, eventId);
    }
  }
}

async function runMirrorBackfill(ctx: PluginContext): Promise<void> {
  const config = await getBridgeConfig(ctx);
  if (!config.autoCreateMirrorIssue) {
    return;
  }

  const providerCompany = await resolveProviderCompany(ctx, config);
  if (!providerCompany) {
    ctx.logger.warn("Mirror backfill skipped because provider company is not configured");
    return;
  }

  const companies = await listCompanies(ctx);
  for (const company of companies) {
    if (company.id === providerCompany.id) {
      continue;
    }

    const issues = await listIssues(ctx, company.id);
    for (const issue of issues) {
      const labels = getLabelNames((issue as unknown as JsonRecord | undefined)?.labels);
      if (!matchesRequesterSignal(issue.title, labels, config)) {
        continue;
      }

      try {
        await ensureMirrorIssue(ctx, issue, config);
      } catch (error) {
        await recordBridgeFailure(
          ctx,
          issue.companyId,
          issue.id,
          issue.identifier ?? issue.id,
          providerCompany,
          error,
        );
        ctx.logger.error("Mirror backfill failed", {
          companyId: issue.companyId,
          issueId: issue.id,
          identifier: issue.identifier,
          error: summarizeError(error),
        });
      }
    }
  }
}

async function handleIssueUpdated(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const refs = extractIssueUpdatedRefs(event);

  if (!refs.companyId || !refs.issueId) {
    return;
  }

  const eventId = asString(event.eventId);
  if (eventId) {
    const processed = await isEventProcessed(ctx, refs.companyId, eventId);
    if (processed) {
      return;
    }
  }

  const currentStatus = await resolveCurrentIssueStatus(ctx, refs.companyId, refs.issueId, refs.status);
  if (!currentStatus) {
    return;
  }

  const links = await listBridgeLinksForLocalIssue(ctx, refs.companyId, refs.issueId);
  if (links.length === 0) {
    if (eventId) {
      await markEventProcessed(ctx, refs.companyId, eventId);
    }
    return;
  }

  for (const link of links) {
    if (!canPropagateLocalToRemote(link.data.direction)) {
      continue;
    }

    await syncLinkedIssueStatus(ctx, {
      companyId: refs.companyId,
      issueId: refs.issueId,
      status: currentStatus,
    }, link);
  }

  if (eventId) {
    await markEventProcessed(ctx, refs.companyId, eventId);
  }
}

function registerDataHandlers(ctx: PluginContext): void {
  registerDataHandler(ctx, DATA_KEYS.listTab, async (params) => {
    return await buildListTabSnapshot(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.detailTab, async (params) => {
    return await buildDetailTabSnapshot(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.dashboardWidget, async (params) => {
    return await buildDashboardWidgetSnapshot(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.createLink, async (params) => {
    return await createBridgeLinkFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.settingsGet, async () => {
    const config = await getBridgeConfig(ctx);
    const companies = await listCompanies(ctx);
    const companyOptions = await Promise.all(
      companies.map(async (company) => ({
        id: company.id,
        name: company.name,
        projects: (await listProjects(ctx, company.id)).map((project) => ({ id: project.id, name: project.name })),
      })),
    );
    const activeCompany = companyOptions.find((company) => company.id === config.providerCompanyId);
    return {
      ...config,
      companies: companyOptions,
      providerProjects: activeCompany?.projects ?? [],
    };
  });
}

function registerActionHandlers(ctx: PluginContext): void {
  registerActionHandler(ctx, ACTION_KEYS.createLink, async (params) => {
    return await createBridgeLinkFromParams(ctx, params);
  });

  // Settings save is handled by UI directly via /api/plugins/:id/config
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    registerDataHandlers(ctx);
    registerActionHandlers(ctx);

    ctx.events.on("issue.created", async (event: PluginEvent) => {
      try {
        await handleIssueCreated(ctx, event);
      } catch (error) {
        const refs = extractIssueCreatedRefs(event);
        if (refs.companyId && refs.issueId) {
          const providerCompany = await resolveProviderCompany(ctx, await getBridgeConfig(ctx));
          await recordBridgeFailure(ctx, refs.companyId, refs.issueId, refs.issueId, providerCompany, error);
        }
        ctx.logger.error("Unhandled bridge issue.created failure", {
          companyId: refs.companyId,
          issueId: refs.issueId,
          error: summarizeError(error),
        });
      }
    });

    ctx.events.on("issue.updated", async (event: PluginEvent) => {
      try {
        await handleIssueUpdated(ctx, event);
      } catch (error) {
        ctx.logger.error("Unhandled bridge issue.updated failure", {
          error: summarizeError(error),
        });
      }
    });

    ctx.jobs.register(JOB_KEYS.mirrorBackfill, async () => {
      await runMirrorBackfill(ctx);
    });

    ctx.logger.info("Service Request Bridge plugin worker initialized", {
      pluginId: PLUGIN_ID,
      supportedDirections: [
        BRIDGE_DIRECTIONS.twoWay,
        BRIDGE_DIRECTIONS.localToRemote,
        BRIDGE_DIRECTIONS.remoteToLocal,
      ],
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Service Request Bridge worker ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
