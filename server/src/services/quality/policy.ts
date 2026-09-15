import { and, desc, eq, isNotNull, isNull } from "drizzle-orm";
import { z } from "zod";
import { activityLog, agents, companies, qualityPolicyVersions, toolDefinitions, type Db } from "@paperclipai/db";
import { finiteCount, qualityPolicySchema, uuidSchema, type QualityHumanActor, type QualityPolicy } from "@paperclipai/shared";
import { badRequest, conflict, notFound } from "../../errors.js";
import { resolveWorkflowSchedulerOwnership, type WorkflowSchedulerOwnershipMode } from "../workflow/scheduler-ownership.js";
import { assertQualityHuman, assertQualityUser } from "./actor.js";
import { assertPolicyTargets, type QualityTx } from "./targets.js";

export { finiteCount };
export function parseQualityPolicy(value: unknown): QualityPolicy {
  const parsed = qualityPolicySchema.safeParse(value);
  if (!parsed.success) {
    const limit = parsed.error.issues.some((issue) => issue.message === "quality_invalid_limit");
    throw badRequest(limit ? "quality_invalid_limit" : "quality_invalid_policy");
  }
  return parsed.data;
}

const createSchema = z.object({ companyId: uuidSchema, policy: z.unknown() }).strict();
const activateSchema = z.object({
  companyId: uuidSchema, policyVersionId: uuidSchema, expectedActivePolicyVersionId: uuidSchema.nullable(),
}).strict();

async function lockCompany(tx: QualityTx, companyId: string): Promise<void> {
  // Serializes version numbering and replacement, including the no-current-policy case.
  const [company] = await tx.select().from(companies).where(eq(companies.id, companyId)).for("update");
  if (!company) throw notFound("quality_company_not_found");
}
async function audit(tx: QualityTx, actor: QualityHumanActor, companyId: string, policyVersionId: string, action: string) {
  await tx.insert(activityLog).values({
    companyId, actorType: "user", actorId: actor.userId, action,
    entityType: "quality_policy", entityId: policyVersionId,
    details: { schemaVersion: 1, source: actor.source, keyId: actor.keyId },
  });
}

export async function createQualityPolicy(db: Db, actor: QualityHumanActor, input: unknown): Promise<{ policyVersionId: string }> {
  const parsed = createSchema.safeParse(input);
  if (!parsed.success) throw badRequest("quality_invalid_policy_request");
  const { companyId } = parsed.data;
  const definition = parseQualityPolicy(parsed.data.policy);
  if (definition.targets.some((target) => target.companyId !== companyId)) throw badRequest("quality_policy_company_mismatch");
  return db.transaction(async (tx) => {
    await lockCompany(tx, companyId);
    await assertQualityHuman(tx, companyId, actor);
    const [latest] = await tx.select({ version: qualityPolicyVersions.version }).from(qualityPolicyVersions)
      .where(eq(qualityPolicyVersions.companyId, companyId)).orderBy(desc(qualityPolicyVersions.version)).limit(1);
    const [row] = await tx.insert(qualityPolicyVersions).values({
      companyId, version: (latest?.version ?? 0) + 1, definition,
    }).returning({ policyVersionId: qualityPolicyVersions.id });
    await audit(tx, actor, companyId, row!.policyVersionId, "quality_policy.created");
    return row!;
  });
}

export async function activateQualityPolicy(db: Db, actor: QualityHumanActor, input: {
  companyId: string; policyVersionId: string; expectedActivePolicyVersionId: string | null;
}, ownershipMode: WorkflowSchedulerOwnershipMode = resolveWorkflowSchedulerOwnership().mode): Promise<{ policyVersionId: string }> {
  const parsed = activateSchema.safeParse(input);
  if (!parsed.success) throw badRequest("quality_invalid_policy_request");
  const { companyId, policyVersionId, expectedActivePolicyVersionId } = parsed.data;
  return db.transaction(async (tx) => {
    await lockCompany(tx, companyId);
    await assertQualityHuman(tx, companyId, actor);
    const [current] = await tx.select().from(qualityPolicyVersions).where(and(
      eq(qualityPolicyVersions.companyId, companyId), isNotNull(qualityPolicyVersions.enabledAt), isNull(qualityPolicyVersions.disabledAt),
    )).for("update");
    if ((current?.id ?? null) !== expectedActivePolicyVersionId) throw conflict("quality_policy_active_conflict");
    const [row] = await tx.select().from(qualityPolicyVersions).where(and(
      eq(qualityPolicyVersions.companyId, companyId), eq(qualityPolicyVersions.id, policyVersionId),
    )).for("update");
    if (!row) throw notFound("quality_policy_not_found");
    if (row.enabledAt || row.disabledAt) throw conflict("quality_policy_already_activated");
    const policy = parseQualityPolicy(row.definition);
    const now = new Date();
    if (now < new Date(policy.periodStart) || now >= new Date(policy.periodEnd)) throw conflict("quality_policy_outside_period");
    // Server execution ownership is separate from the policy's human approval.
    // The API supplies the same boot-time mode used to configure both schedulers.
    if (ownershipMode !== "native-active-plugin-disabled") throw conflict("quality_policy_native_ownership_required");
    await assertPolicyTargets(tx, companyId, policy);
    for (const id of [...policy.authorAgentIds, ...policy.verifierAgentIds]) {
      const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, id))).for("share");
      if (!agent || !["active", "idle", "running"].includes(agent.status)) throw conflict("quality_policy_agent_unavailable");
    }
    for (const id of policy.allowedToolIds) {
      const [tool] = await tx.select().from(toolDefinitions).where(and(eq(toolDefinitions.companyId, companyId), eq(toolDefinitions.id, id))).for("share");
      if (!tool?.enabled) throw conflict("quality_policy_tool_unavailable");
    }
    for (const userId of new Set([...policy.reviewerUserIds, ...policy.rollbackUserIds])) await assertQualityUser(tx, companyId, userId);
    if (current) await tx.update(qualityPolicyVersions).set({ disabledAt: now, updatedAt: now }).where(eq(qualityPolicyVersions.id, current.id));
    await tx.update(qualityPolicyVersions).set({
      approvedByUserId: actor.userId, approvedAt: now, enabledAt: now, updatedAt: now,
    }).where(and(eq(qualityPolicyVersions.companyId, companyId), eq(qualityPolicyVersions.id, policyVersionId)));
    await audit(tx, actor, companyId, policyVersionId, "quality_policy.activated");
    // No group/usage writes: earlier budgets and reservations retain their original ownership.
    return { policyVersionId };
  });
}
