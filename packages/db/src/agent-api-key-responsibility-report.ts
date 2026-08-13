import postgres from "postgres";

export const AGENT_API_KEY_RESPONSIBILITY_MIGRATION =
  "0087_agent_api_keys_responsibility_scope" as const;
export const AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION =
  "agent_api_key.responsibility_migration_reported" as const;

export type AgentApiKeyResponsibilitySource = "direct_key_created" | "join_claim";
export type AgentApiKeyResponsibilityDecision = "backfill" | "revoke" | "preserve_revoked";
export type AgentApiKeyResponsibilityReportMode = "preview" | "stored";
export type AgentApiKeyResponsibilityRequestedMode = "auto" | AgentApiKeyResponsibilityReportMode;
export type AgentApiKeyResponsibilityCandidate = {
  userId: string;
  sources: AgentApiKeyResponsibilitySource[];
  eligible: boolean;
  eligibilityReasonCodes: string[];
};
export type AgentApiKeyResponsibilityReportKey = {
  keyId: string;
  companyId: string;
  agentId: string;
  keyName: string;
  decision: AgentApiKeyResponsibilityDecision;
  reasonCodes: string[];
  candidates: AgentApiKeyResponsibilityCandidate[];
  resolvedUserId: string | null;
  requiresOperatorAction: boolean;
};
export type AgentApiKeyResponsibilityReport = {
  schemaVersion: 1;
  migration: typeof AGENT_API_KEY_RESPONSIBILITY_MIGRATION;
  mode: AgentApiKeyResponsibilityReportMode;
  generatedAt: string;
  summary: { totalKeys: number; backfillCount: number; revokeCount: number; preserveRevokedCount: number; requiresOperatorActionCount: number };
  keys: AgentApiKeyResponsibilityReportKey[];
};
export type AgentApiKeyResponsibilityEvidence = {
  keyId: string;
  companyId: string;
  agentId: string;
  keyName: string;
  revoked?: boolean;
  userId?: string | null;
  source?: AgentApiKeyResponsibilitySource | null;
  userExists?: boolean;
  companyMembershipExists?: boolean;
  activeCompanyMembership?: boolean;
  instanceAdmin?: boolean;
};

type MutableCandidate = { sources: Set<AgentApiKeyResponsibilitySource>; userExists: boolean; membershipExists: boolean; activeMembership: boolean; instanceAdmin: boolean };
type MutableKey = Omit<AgentApiKeyResponsibilityEvidence, "userId" | "source"> & { candidates: Map<string, MutableCandidate> };
type AgentApiKeyResponsibilityPostgresFactory = typeof postgres;

export const compareAgentApiKeyResponsibilityLexical = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

let postgresFactory: AgentApiKeyResponsibilityPostgresFactory = postgres;

export function setAgentApiKeyResponsibilityPostgresFactoryForTests(
  factory: AgentApiKeyResponsibilityPostgresFactory,
): () => void {
  const previous = postgresFactory;
  postgresFactory = factory;
  return () => {
    postgresFactory = previous;
  };
}

const decisionReasons = new Set(["exactly_one_eligible_candidate", "no_provenance", "no_eligible_candidate", "conflicting_eligible_candidates", "already_revoked"]);
const eligibilityReasons = new Set(["active_company_membership", "instance_admin", "user_not_found", "company_membership_missing", "company_membership_inactive"]);
const sources = new Set<AgentApiKeyResponsibilitySource>(["direct_key_created", "join_claim"]);
const decisions = new Set<AgentApiKeyResponsibilityDecision>(["backfill", "revoke", "preserve_revoked"]);

function summary(keys: AgentApiKeyResponsibilityReportKey[]) {
  return {
    totalKeys: keys.length,
    backfillCount: keys.filter((key) => key.decision === "backfill").length,
    revokeCount: keys.filter((key) => key.decision === "revoke").length,
    preserveRevokedCount: keys.filter((key) => key.decision === "preserve_revoked").length,
    requiresOperatorActionCount: keys.filter((key) => key.requiresOperatorAction).length,
  };
}

function candidateFrom(userId: string, value: MutableCandidate): AgentApiKeyResponsibilityCandidate {
  const reasonCodes = value.userExists
    ? [
        ...(value.activeMembership ? ["active_company_membership"] : [value.membershipExists ? "company_membership_inactive" : "company_membership_missing"]),
        ...(value.instanceAdmin ? ["instance_admin"] : []),
      ]
    : ["user_not_found"];
  return {
    userId,
    sources: [...value.sources].sort(compareAgentApiKeyResponsibilityLexical),
    eligible: value.userExists && (value.activeMembership || value.instanceAdmin),
    eligibilityReasonCodes: reasonCodes.sort(compareAgentApiKeyResponsibilityLexical),
  };
}

export function buildAgentApiKeyResponsibilityReport(
  rows: AgentApiKeyResponsibilityEvidence[],
  mode: AgentApiKeyResponsibilityReportMode,
  generatedAt = new Date().toISOString(),
): AgentApiKeyResponsibilityReport {
  const grouped = new Map<string, MutableKey>();
  for (const row of rows) {
    let key = grouped.get(row.keyId);
    if (!key) {
      key = { keyId: row.keyId, companyId: row.companyId, agentId: row.agentId, keyName: row.keyName, revoked: Boolean(row.revoked), candidates: new Map() };
      grouped.set(row.keyId, key);
    }
    if (!row.userId || !row.source) continue;
    let candidate = key.candidates.get(row.userId);
    if (!candidate) {
      candidate = { sources: new Set(), userExists: Boolean(row.userExists), membershipExists: Boolean(row.companyMembershipExists || row.activeCompanyMembership), activeMembership: Boolean(row.activeCompanyMembership), instanceAdmin: Boolean(row.instanceAdmin) };
      key.candidates.set(row.userId, candidate);
    }
    candidate.sources.add(row.source);
    candidate.userExists ||= Boolean(row.userExists);
    candidate.membershipExists ||= Boolean(row.companyMembershipExists || row.activeCompanyMembership);
    candidate.activeMembership ||= Boolean(row.activeCompanyMembership);
    candidate.instanceAdmin ||= Boolean(row.instanceAdmin);
  }
  const keys = [...grouped.values()].map((key): AgentApiKeyResponsibilityReportKey => {
    const candidates = [...key.candidates]
      .map(([userId, value]) => candidateFrom(userId, value))
      .sort((left, right) => compareAgentApiKeyResponsibilityLexical(left.userId, right.userId));
    const eligible = candidates.filter((candidate) => candidate.eligible);
    const decision: AgentApiKeyResponsibilityDecision = key.revoked ? "preserve_revoked" : eligible.length === 1 ? "backfill" : "revoke";
    const reason = key.revoked ? "already_revoked" : eligible.length === 1 ? "exactly_one_eligible_candidate" : candidates.length === 0 ? "no_provenance" : eligible.length === 0 ? "no_eligible_candidate" : "conflicting_eligible_candidates";
    return {
      keyId: key.keyId,
      companyId: key.companyId,
      agentId: key.agentId,
      keyName: key.keyName,
      decision,
      reasonCodes: [reason].sort(compareAgentApiKeyResponsibilityLexical),
      candidates,
      resolvedUserId: decision === "backfill" ? eligible[0]!.userId : null,
      requiresOperatorAction: decision === "revoke",
    };
  }).sort((left, right) =>
    compareAgentApiKeyResponsibilityLexical(left.companyId, right.companyId)
    || compareAgentApiKeyResponsibilityLexical(left.agentId, right.agentId)
    || compareAgentApiKeyResponsibilityLexical(left.keyId, right.keyId),
  );
  return { schemaVersion: 1, migration: AGENT_API_KEY_RESPONSIBILITY_MIGRATION, mode, generatedAt, summary: summary(keys), keys };
}

const previewQuery = `
WITH direct_evidence AS (
  SELECT k.id key_id, al.actor_id user_id, 'direct_key_created' source
  FROM agent_api_keys k JOIN activity_log al
    ON al.action = 'agent.key_created' AND al.entity_type = 'agent'
   AND al.entity_id = k.agent_id::text AND al.company_id = k.company_id
   AND al.actor_type = 'user' AND al.details->>'keyId' = k.id::text
), join_evidence AS (
  SELECT k.id key_id, approved.actor_id user_id, 'join_claim' source
  FROM agent_api_keys k JOIN activity_log claim
    ON claim.action = 'agent_api_key.claimed' AND claim.entity_type = 'agent_api_key'
   AND claim.entity_id = k.id::text AND claim.details->>'agentId' = k.agent_id::text
  JOIN join_requests jr ON claim.details->>'joinRequestId' = jr.id::text
   AND jr.request_type = 'agent' AND jr.status = 'approved' AND jr.approved_at IS NOT NULL
   AND jr.claim_secret_consumed_at IS NOT NULL AND jr.company_id = k.company_id AND jr.created_agent_id = k.agent_id
  JOIN activity_log approved ON approved.action = 'join.approved' AND approved.entity_type = 'join_request'
   AND approved.entity_id = jr.id::text AND approved.actor_type = 'user' AND approved.actor_id = jr.approved_by_user_id
), evidence AS (SELECT * FROM direct_evidence UNION ALL SELECT * FROM join_evidence)
SELECT k.id::text "keyId", k.company_id::text "companyId", k.agent_id::text "agentId", k.name "keyName",
  (k.revoked_at IS NOT NULL) revoked, e.user_id "userId", e.source,
  (u.id IS NOT NULL) "userExists",
  EXISTS (SELECT 1 FROM company_memberships cm WHERE cm.company_id = k.company_id AND cm.principal_type = 'user' AND cm.principal_id = e.user_id) "companyMembershipExists",
  EXISTS (SELECT 1 FROM company_memberships cm WHERE cm.company_id = k.company_id AND cm.principal_type = 'user' AND cm.principal_id = e.user_id AND cm.status = 'active') "activeCompanyMembership",
  EXISTS (SELECT 1 FROM instance_user_roles r WHERE r.user_id = e.user_id AND r.role = 'instance_admin') "instanceAdmin"
FROM agent_api_keys k LEFT JOIN evidence e ON e.key_id = k.id LEFT JOIN "user" u ON u.id = e.user_id`;

export async function previewAgentApiKeyResponsibilityReport(connectionString: string): Promise<AgentApiKeyResponsibilityReport> {
  const sql = postgresFactory(connectionString, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.begin("read only", async (tx) => await tx.unsafe<AgentApiKeyResponsibilityEvidence[]>(previewQuery));
    return buildAgentApiKeyResponsibilityReport(rows, "preview");
  } finally { await sql.end(); }
}

export class AgentApiKeyResponsibilityReceiptNotFoundError extends Error {
  constructor() { super("No exact stored agent API-key responsibility receipt exists."); this.name = "AgentApiKeyResponsibilityReceiptNotFoundError"; }
}

function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).sort(compareAgentApiKeyResponsibilityLexical).join("\0")
    === [...expected].sort(compareAgentApiKeyResponsibilityLexical).join("\0");
}
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function stringArray(value: unknown, allowed: Set<string>): value is string[] {
  return Array.isArray(value)
    && value.every((item) => typeof item === "string" && allowed.has(item))
    && new Set(value).size === value.length
    && value.join("\0") === [...value].sort(compareAgentApiKeyResponsibilityLexical).join("\0");
}
function validCandidate(value: unknown): value is AgentApiKeyResponsibilityCandidate {
  if (!object(value) || !exactKeys(value, ["userId", "sources", "eligible", "eligibilityReasonCodes"]) || typeof value.userId !== "string" || !stringArray(value.sources, sources) || value.sources.length === 0 || typeof value.eligible !== "boolean" || !stringArray(value.eligibilityReasonCodes, eligibilityReasons)) return false;
  const positive = value.eligibilityReasonCodes.some((reason) => reason === "active_company_membership" || reason === "instance_admin");
  return value.eligible ? positive : !positive && value.eligibilityReasonCodes.length === 1;
}
function validKey(value: unknown): value is AgentApiKeyResponsibilityReportKey {
  if (!object(value) || !exactKeys(value, ["keyId", "companyId", "agentId", "keyName", "decision", "reasonCodes", "candidates", "resolvedUserId", "requiresOperatorAction"])) return false;
  if (![value.keyId, value.companyId, value.agentId, value.keyName].every((item) => typeof item === "string") || typeof value.decision !== "string" || !decisions.has(value.decision as AgentApiKeyResponsibilityDecision) || !stringArray(value.reasonCodes, decisionReasons) || value.reasonCodes.length !== 1 || !Array.isArray(value.candidates) || (value.resolvedUserId !== null && typeof value.resolvedUserId !== "string") || typeof value.requiresOperatorAction !== "boolean") return false;
  if (!value.candidates.every(validCandidate)) return false;
  const candidates = value.candidates as AgentApiKeyResponsibilityCandidate[];
  if (candidates.some((candidate, index) =>
    index > 0
    && compareAgentApiKeyResponsibilityLexical(candidates[index - 1]!.userId, candidate.userId) >= 0,
  )) return false;
  const eligible = candidates.filter((candidate) => candidate.eligible);
  const expectedReason = value.decision === "preserve_revoked" ? "already_revoked" : eligible.length === 1 ? "exactly_one_eligible_candidate" : candidates.length === 0 ? "no_provenance" : eligible.length === 0 ? "no_eligible_candidate" : "conflicting_eligible_candidates";
  return value.reasonCodes[0] === expectedReason
    && (value.decision === "backfill" ? eligible.length === 1 && value.resolvedUserId === eligible[0]!.userId && !value.requiresOperatorAction : value.resolvedUserId === null)
    && (value.decision === "revoke" ? value.requiresOperatorAction && eligible.length !== 1 : !value.requiresOperatorAction);
}
function parseReceipt(details: unknown): { generatedAt: string; key: AgentApiKeyResponsibilityReportKey } {
  if (!object(details) || !exactKeys(details, ["schemaVersion", "migration", "generatedAt", "key"]) || details.schemaVersion !== 1 || details.migration !== AGENT_API_KEY_RESPONSIBILITY_MIGRATION || typeof details.generatedAt !== "string" || !Number.isFinite(Date.parse(details.generatedAt)) || !validKey(details.key)) throw new Error("Malformed stored responsibility receipt.");
  return { generatedAt: details.generatedAt, key: details.key };
}

export async function readStoredAgentApiKeyResponsibilityReceipt(connectionString: string): Promise<AgentApiKeyResponsibilityReport> {
  const sql = postgresFactory(connectionString, { max: 1, onnotice: () => {} });
  try {
    const rows = await sql.begin("read only", async (tx) => await tx.unsafe<{ companyId: string; entityType: string; entityId: string; agentId: string | null; details: unknown }[]>(`SELECT company_id::text "companyId", entity_type "entityType", entity_id "entityId", agent_id::text "agentId", details FROM activity_log WHERE action = '${AGENT_API_KEY_RESPONSIBILITY_REPORT_ACTION}' AND actor_type = 'system' AND actor_id = 'migration:${AGENT_API_KEY_RESPONSIBILITY_MIGRATION}' ORDER BY company_id::text COLLATE "C", agent_id::text COLLATE "C", entity_id COLLATE "C", id::text COLLATE "C"`));
    if (rows.length === 0) throw new AgentApiKeyResponsibilityReceiptNotFoundError();
    const receipts = rows.map((row) => ({ row, ...parseReceipt(row.details) }));
    const seen = new Set<string>();
    for (const receipt of receipts) {
      if (receipt.row.entityType !== "agent_api_key" || receipt.key.companyId !== receipt.row.companyId || receipt.key.agentId !== receipt.row.agentId || receipt.key.keyId !== receipt.row.entityId || seen.has(receipt.key.keyId)) throw new Error("Malformed stored responsibility receipt.");
      seen.add(receipt.key.keyId);
    }
    const keys = receipts.map((receipt) => ({
      ...receipt.key,
      reasonCodes: [...receipt.key.reasonCodes].sort(compareAgentApiKeyResponsibilityLexical),
      candidates: receipt.key.candidates
        .map((candidate) => ({
          ...candidate,
          sources: [...candidate.sources].sort(compareAgentApiKeyResponsibilityLexical),
          eligibilityReasonCodes: [...candidate.eligibilityReasonCodes].sort(compareAgentApiKeyResponsibilityLexical),
        }))
        .sort((left, right) => compareAgentApiKeyResponsibilityLexical(left.userId, right.userId)),
    })).sort((left, right) =>
      compareAgentApiKeyResponsibilityLexical(left.companyId, right.companyId)
      || compareAgentApiKeyResponsibilityLexical(left.agentId, right.agentId)
      || compareAgentApiKeyResponsibilityLexical(left.keyId, right.keyId),
    );
    return {
      schemaVersion: 1,
      migration: AGENT_API_KEY_RESPONSIBILITY_MIGRATION,
      mode: "stored",
      generatedAt: receipts.map((receipt) => receipt.generatedAt).sort(compareAgentApiKeyResponsibilityLexical).at(-1)!,
      summary: summary(keys),
      keys,
    };
  } finally { await sql.end(); }
}

export async function exportAgentApiKeyResponsibilityReport(connectionString: string, requestedMode: AgentApiKeyResponsibilityRequestedMode = "auto"): Promise<AgentApiKeyResponsibilityReport> {
  if (requestedMode === "preview") return previewAgentApiKeyResponsibilityReport(connectionString);
  if (requestedMode === "stored") return readStoredAgentApiKeyResponsibilityReceipt(connectionString);
  try { return await readStoredAgentApiKeyResponsibilityReceipt(connectionString); }
  catch (error) {
    if (error?.constructor === AgentApiKeyResponsibilityReceiptNotFoundError) return previewAgentApiKeyResponsibilityReport(connectionString);
    throw error;
  }
}
