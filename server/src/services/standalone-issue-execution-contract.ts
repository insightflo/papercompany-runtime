import { and, eq, inArray } from "drizzle-orm";
import { agents, companySkills, heartbeatRuns, issueExecutionCards, issues, type Db, type IssueExecutionCardJson } from "@paperclipai/db";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { findServerAdapter } from "../adapters/index.js";
import { companySkillService } from "./company-skills.js";
import { hashStructuredValue } from "./issue-execution-cards/hash.js";
import { listWorkflowToolCatalog } from "./workflow/tool-catalog.js";

type RecordValue = Record<string, unknown>;
type IssueRow = typeof issues.$inferSelect;
type AgentRow = typeof agents.$inferSelect;

export type StandaloneIssueExecutionCardV2 = {
  version: 2;
  executionMode: "standalone";
  issue: { id: string; companyId: string; assigneeAgentId: string; originKind: "manual" };
  requiredSkillRefs: string[];
  toolPermissionContract: { requiredToolNames: string[]; allowedToolNames: string[] };
  completionContract: { requiredEvidence: string[]; independentQaRequired: boolean; approvalRequired: boolean };
};

type Result = {
  contract: StandaloneIssueExecutionCardV2 | null;
  effective: { skillRefs: string[]; toolNames: string[] };
  blockers: string[];
};

function record(value: unknown): RecordValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as RecordValue : {};
}
function text(value: unknown): string { return typeof value === "string" ? value.trim() : ""; }
function strings(value: unknown): string[] {
  return Array.from(new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim()) : []));
}
function booleans(value: unknown): boolean { return value === true; }
function standalone(value: unknown): value is StandaloneIssueExecutionCardV2 {
  const card = record(value);
  const issue = record(card.issue);
  return card.version === 2 && card.executionMode === "standalone" && issue.originKind === "manual";
}
function manual(issue: IssueRow): boolean {
  return issue.originKind === "manual";
}

async function issue(db: Db, companyId: string, issueId: string) {
  return db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1).then((rows) => rows[0] ?? null);
}
async function agent(db: Db, companyId: string, agentId: string | null) {
  if (!agentId) return null;
  return db.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, agentId))).limit(1).then((rows) => rows[0] ?? null);
}
async function stored(db: Db, companyId: string, issueId: string) {
  return db.select().from(issueExecutionCards).where(and(eq(issueExecutionCards.companyId, companyId), eq(issueExecutionCards.issueId, issueId))).limit(1).then((rows) => rows[0] ?? null);
}
async function active(db: Db, companyId: string, issueId: string) {
  return db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.issueId, issueId), inArray(heartbeatRuns.status, ["queued", "running"]))).limit(1).then((rows) => rows[0] ?? null);
}
function payload(value: unknown): Omit<StandaloneIssueExecutionCardV2, "version" | "executionMode" | "issue"> {
  const input = record(value);
  const completion = record(input.completionContract);
  return {
    requiredSkillRefs: strings(input.requiredSkillRefs),
    toolPermissionContract: { requiredToolNames: strings(input.requiredToolNames), allowedToolNames: strings(input.allowedToolNames) },
    completionContract: { requiredEvidence: strings(completion.requiredEvidence), independentQaRequired: booleans(completion.independentQaRequired), approvalRequired: booleans(completion.approvalRequired) },
  };
}

async function validate(input: {
  db: Db; companyId: string; issue: IssueRow; assignee: AgentRow | null;
  requiredSkillRefs: string[]; requiredToolNames: string[]; allowedToolNames: string[];
}): Promise<{ blockers: string[]; effective: Result["effective"] }> {
  const blockers: string[] = [];
  if (!manual(input.issue)) blockers.push("issue_not_manual");
  if (!input.assignee) blockers.push("assignee_missing_or_not_in_company");

  const skillSvc = companySkillService(input.db);
  const resolvedSkillKeys: string[] = [];
  for (const ref of input.requiredSkillRefs) {
    try {
      const resolved = await skillSvc.resolveRequestedSkillKeys(input.companyId, [ref]);
      if (resolved.length === 0) blockers.push("skill_not_found");
      resolvedSkillKeys.push(...resolved);
    } catch { blockers.push("skill_reference_invalid"); }
  }
  const skillKeys = Array.from(new Set(resolvedSkillKeys));
  const skills = skillKeys.length > 0
    ? await input.db.select().from(companySkills).where(and(eq(companySkills.companyId, input.companyId), inArray(companySkills.key, skillKeys)))
    : [];
  if (skills.length !== skillKeys.length) blockers.push("skill_not_found");
  const skillByKey = new Map(skills.map((skill) => [skill.key, skill]));
  const effectiveSkillRefs: string[] = [];
  let runtimeKeys = new Set<string>();
  if (input.assignee) {
    const runtimeEntries = await skillSvc.listRuntimeSkillEntries(input.companyId);
    runtimeKeys = new Set(runtimeEntries.map((entry) => entry.key));
    const providerSupportsSkills = Boolean(findServerAdapter(input.assignee.adapterType)?.listSkills);
    if (!providerSupportsSkills) blockers.push("provider_skill_support_unavailable");
    let desiredKeys: string[] = [];
    try {
      const refs = readPaperclipSkillSyncPreference(record(input.assignee.adapterConfig)).desiredSkills;
      desiredKeys = await skillSvc.resolveRequestedSkillKeys(input.companyId, strings(refs));
    } catch { /* desired references are not authoritative contract input */ }
    for (const key of skillKeys) {
      const skill = skillByKey.get(key) as (typeof skills)[number] | undefined;
      if (!skill) continue;
      const skillBlockers: string[] = [];
      if (record(skill).compatibility !== "compatible") {
        blockers.push(`skill_incompatible:${key}`);
        skillBlockers.push("skill_incompatible");
      }
      if (text(record(skill).status) && text(record(skill).status) !== "active") {
        blockers.push(`skill_not_active:${key}`);
        skillBlockers.push("skill_not_active");
      }
      if (!desiredKeys.includes(key)) {
        blockers.push(`skill_not_desired:${key}`);
        skillBlockers.push("skill_not_desired");
      }
      if (!providerSupportsSkills || !runtimeKeys.has(key)) {
        blockers.push(`skill_not_materializable:${key}`);
        skillBlockers.push("skill_not_materializable");
      }
      if (skillBlockers.length === 0) effectiveSkillRefs.push(key);
    }
  }

  const required = new Set(input.requiredToolNames);
  const allowed = new Set(input.allowedToolNames);
  for (const name of required) if (!allowed.has(name)) blockers.push(`required_tool_not_allowed:${name}`);
  const catalog = await listWorkflowToolCatalog(input.db, input.companyId);
  const effectiveToolNames: string[] = [];
  for (const name of allowed) {
    const tool = catalog.tools.find((entry) => entry.name === name);
    const registered = Boolean(tool);
    const enabled = Boolean(tool?.enabled);
    const granted = Boolean(input.assignee && catalog.grants.some((grant) => grant.agentId === input.assignee!.id && grant.toolName === name));
    if (!registered) blockers.push(`tool_not_registered:${name}`);
    else if (!enabled) blockers.push(`tool_not_enabled:${name}`);
    else if (!granted) blockers.push(`tool_not_granted:${name}`);
    if (registered && enabled && granted) effectiveToolNames.push(name);
  }
  return { blockers: Array.from(new Set(blockers)), effective: { skillRefs: effectiveSkillRefs, toolNames: effectiveToolNames } };
}

export function standaloneIssueExecutionContractService(db: Db) {
  async function get(companyId: string, issueId: string): Promise<Result | null> {
    const currentIssue = await issue(db, companyId, issueId);
    if (!currentIssue) return null;
    const row = await stored(db, companyId, issueId);
    const card = standalone(row?.cardJson) ? row!.cardJson as StandaloneIssueExecutionCardV2 : null;
    const assignee = await agent(db, companyId, currentIssue.assigneeAgentId);
    const validation = card ? await validate({ db, companyId, issue: currentIssue, assignee, requiredSkillRefs: card.requiredSkillRefs, requiredToolNames: card.toolPermissionContract.requiredToolNames, allowedToolNames: card.toolPermissionContract.allowedToolNames }) : { blockers: [], effective: { skillRefs: [], toolNames: [] } };
    const blockers = [...validation.blockers];
    if (row && !card) blockers.push("workflow_execution_card_managed_elsewhere");
    if (await active(db, companyId, issueId)) blockers.push("active_run");
    return { contract: card, effective: validation.effective, blockers: Array.from(new Set(blockers)) };
  }

  async function put(companyId: string, issueId: string, body: unknown) {
    const currentIssue = await issue(db, companyId, issueId);
    if (!currentIssue) return { kind: "not_found" as const };
    const run = await active(db, companyId, issueId);
    if (run) return { kind: "conflict" as const, reason: "active_run", runId: run.id };
    const row = await stored(db, companyId, issueId);
    if (row && !standalone(row.cardJson)) return { kind: "conflict" as const, reason: "workflow_execution_card_managed_elsewhere" };
    const values = payload(body);
    const assignee = await agent(db, companyId, currentIssue.assigneeAgentId);
    const validation = await validate({ db, companyId, issue: currentIssue, assignee, requiredSkillRefs: values.requiredSkillRefs, requiredToolNames: values.toolPermissionContract.requiredToolNames, allowedToolNames: values.toolPermissionContract.allowedToolNames });
    const card: StandaloneIssueExecutionCardV2 = { version: 2, executionMode: "standalone", issue: { id: currentIssue.id, companyId, assigneeAgentId: currentIssue.assigneeAgentId ?? "", originKind: "manual" }, ...values };
    const result = { contract: card, effective: validation.effective, blockers: validation.blockers };
    if (validation.blockers.length > 0) return { kind: "invalid" as const, response: result };
    const contentHash = hashStructuredValue(card);
    await db.insert(issueExecutionCards).values({ companyId, issueId, missionId: currentIssue.missionId ?? null, workflowRunId: null, workflowStepRunId: null, cardVersion: 2, contentHash, cardJson: card as unknown as IssueExecutionCardJson, updatedAt: new Date() }).onConflictDoUpdate({ target: [issueExecutionCards.companyId, issueExecutionCards.issueId], set: { missionId: currentIssue.missionId ?? null, workflowRunId: null, workflowStepRunId: null, cardVersion: 2, contentHash, cardJson: card as unknown as IssueExecutionCardJson, updatedAt: new Date() } });
    return { kind: "ok" as const, response: result, contentHash };
  }

  async function validateAssigneeChange(companyId: string, issueId: string, nextAssigneeAgentId: string) {
    const currentIssue = await issue(db, companyId, issueId);
    if (!currentIssue) return null;
    const row = await stored(db, companyId, issueId);
    const card = standalone(row?.cardJson) ? row!.cardJson as StandaloneIssueExecutionCardV2 : null;
    if (!card) return null;
    const assignee = await agent(db, companyId, nextAssigneeAgentId);
    const validation = await validate({
      db,
      companyId,
      issue: currentIssue,
      assignee,
      requiredSkillRefs: card.requiredSkillRefs,
      requiredToolNames: card.toolPermissionContract.requiredToolNames,
      allowedToolNames: card.toolPermissionContract.allowedToolNames,
    });
    return { blockers: validation.blockers, effective: validation.effective };
  }

  return { get, put, validateAssigneeChange };
}
