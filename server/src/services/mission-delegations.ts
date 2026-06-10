import { and, eq, inArray } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agents,
  companies,
  issueComments,
  issueWorkProducts,
  issues,
  missionDelegations,
  missions,
} from "@paperclipai/db";
import { badRequest, notFound, unprocessable } from "../errors.js";
import { issueService } from "./issues.js";
import { missionService, type MissionStatus } from "./missions.js";

type MissionRow = typeof missions.$inferSelect;
type MissionDelegationRow = typeof missionDelegations.$inferSelect;

export type CreateMissionDelegationInput = {
  sourceMissionId: string;
  externalKey?: string;
  targetCompanyId: string;
  targetOwnerAgentId: string;
  title?: string;
  description?: string | null;
  sourceIssueTitle?: string;
  priority?: string;
  metadata?: Record<string, unknown>;
};

function readPriority(value: string | undefined): "low" | "medium" | "high" | "urgent" {
  if (value === "low" || value === "high" || value === "urgent") return value;
  return "medium";
}

function buildTargetMissionDescription(input: {
  sourceMission: MissionRow;
  sourceIssueId: string;
  sourceIssueIdentifier: string | null;
  description: string | null;
}): string {
  return [
    input.description,
    "",
    "Cross-company mission boundary:",
    `- sourceCompanyId: ${input.sourceMission.companyId}`,
    `- sourceMissionId: ${input.sourceMission.id}`,
    `- sourceTrackerIssueId: ${input.sourceIssueId}`,
    `- sourceTrackerIssueIdentifier: ${input.sourceIssueIdentifier ?? "none"}`,
    "",
    "Delivery contract:",
    "- Complete the delegated mission through its own mission/issues/workflow structure.",
    "- Register official deliverables as issue workProducts before marking the target mission completed.",
    "- When the target mission is completed, Paperclip copies those workProducts back to the source tracker issue.",
  ].filter((line): line is string => line !== null && line !== undefined).join("\n");
}

function buildSourceIssueDescription(input: {
  sourceMission: MissionRow;
  targetCompanyId: string;
  title: string;
  description: string | null;
}): string {
  return [
    `Waiting for delegated mission from company ${input.targetCompanyId}.`,
    "",
    "Source mission:",
    `- missionId: ${input.sourceMission.id}`,
    `- title: ${input.sourceMission.title}`,
    "",
    `Delegated mission title: ${input.title}`,
    input.description ? `Delegated mission brief:\n${input.description}` : null,
    "",
    "This tracker issue is resolved automatically when the delegated target mission reaches a terminal status.",
  ].filter((line): line is string => line !== null).join("\n");
}

async function comment(db: Db, input: {
  companyId: string;
  issueId: string;
  body: string;
}): Promise<void> {
  await db.insert(issueComments).values({
    companyId: input.companyId,
    issueId: input.issueId,
    body: input.body,
    authorUserId: "mission-delegation",
  });
}

async function copyTargetMissionWorkProductsToSourceIssue(db: Db, delegation: MissionDelegationRow): Promise<number> {
  if (!delegation.sourceIssueId) return 0;

  const targetIssues = await db
    .select({ id: issues.id })
    .from(issues)
    .where(and(eq(issues.companyId, delegation.targetCompanyId), eq(issues.missionId, delegation.targetMissionId)));
  if (targetIssues.length === 0) return 0;

  const products = await db
    .select()
    .from(issueWorkProducts)
    .where(inArray(issueWorkProducts.issueId, targetIssues.map((issue) => issue.id)));

  let copied = 0;
  for (const product of products) {
    const externalId = `delegated-mission:${delegation.targetMissionId}:${product.id}`;
    const exists = await db
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, delegation.sourceCompanyId),
        eq(issueWorkProducts.issueId, delegation.sourceIssueId),
        eq(issueWorkProducts.provider, "delegated_mission"),
        eq(issueWorkProducts.externalId, externalId),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (exists) continue;

    await db.insert(issueWorkProducts).values({
      companyId: delegation.sourceCompanyId,
      projectId: null,
      issueId: delegation.sourceIssueId,
      executionWorkspaceId: null,
      runtimeServiceId: null,
      type: product.type,
      provider: "delegated_mission",
      externalId,
      title: product.title,
      url: product.url,
      status: product.status,
      reviewState: product.reviewState,
      isPrimary: product.isPrimary,
      healthStatus: product.healthStatus,
      summary: product.summary,
      metadata: {
        delegatedMission: {
          delegationId: delegation.id,
          targetCompanyId: delegation.targetCompanyId,
          targetMissionId: delegation.targetMissionId,
          targetIssueId: product.issueId,
          targetWorkProductId: product.id,
        },
        originalProvider: product.provider,
        originalExternalId: product.externalId,
        originalMetadata: product.metadata ?? null,
      },
      createdByRunId: null,
    });
    copied += 1;
  }
  return copied;
}

export function missionDelegationService(db: Db) {
  async function create(input: CreateMissionDelegationInput) {
    const externalKey = input.externalKey?.trim() || null;
    if (externalKey) {
      const existing = await db
        .select()
        .from(missionDelegations)
        .where(and(eq(missionDelegations.sourceMissionId, input.sourceMissionId), eq(missionDelegations.externalKey, externalKey)))
        .limit(1)
        .then((rows) => rows[0] ?? null);
      if (existing) {
        const sourceIssue = existing.sourceIssueId ? await issueService(db).getById(existing.sourceIssueId) : null;
        const targetMission = await missionService(db).getById(existing.targetMissionId);
        if (!sourceIssue || !targetMission) {
          throw notFound(`Existing mission delegation is missing source issue or target mission: ${existing.id}`);
        }
        return { delegation: existing, sourceIssue, targetMission };
      }
    }

    const [sourceMission] = await db
      .select()
      .from(missions)
      .where(eq(missions.id, input.sourceMissionId))
      .limit(1);
    if (!sourceMission) throw notFound(`Source mission not found: ${input.sourceMissionId}`);
    if (sourceMission.companyId === input.targetCompanyId) {
      throw badRequest("Cross-company mission delegation requires a different target company");
    }
    if (sourceMission.status === "completed" || sourceMission.status === "cancelled") {
      throw unprocessable("Cannot delegate from a completed or cancelled mission");
    }

    const [targetCompany] = await db
      .select({ id: companies.id, name: companies.name })
      .from(companies)
      .where(eq(companies.id, input.targetCompanyId))
      .limit(1);
    if (!targetCompany) throw notFound(`Target company not found: ${input.targetCompanyId}`);

    const [targetOwner] = await db
      .select({ id: agents.id, companyId: agents.companyId, name: agents.name })
      .from(agents)
      .where(eq(agents.id, input.targetOwnerAgentId))
      .limit(1);
    if (!targetOwner || targetOwner.companyId !== input.targetCompanyId) {
      throw notFound(`Target owner agent not found in target company: ${input.targetOwnerAgentId}`);
    }

    const title = input.title?.trim() || sourceMission.title;
    const sourceIssue = await issueService(db).create(sourceMission.companyId, {
      missionId: sourceMission.id,
      title: input.sourceIssueTitle?.trim() || `[DELEGATED] ${targetCompany.name}: ${title}`,
      description: buildSourceIssueDescription({
        sourceMission,
        targetCompanyId: targetCompany.id,
        title,
        description: input.description ?? null,
      }),
      assigneeAgentId: sourceMission.ownerAgentId,
      status: "blocked",
      priority: readPriority(input.priority),
      originKind: "mission_delegation_source",
      originId: sourceMission.id,
    });

    const targetMission = await missionService(db).create({
      companyId: targetCompany.id,
      ownerAgentId: targetOwner.id,
      title: `[DELEGATED] ${title}`,
      description: buildTargetMissionDescription({
        sourceMission,
        sourceIssueId: sourceIssue.id,
        sourceIssueIdentifier: sourceIssue.identifier ?? null,
        description: input.description ?? null,
      }),
      status: "planning",
      source: "manual",
    });

    const [delegation] = await db.insert(missionDelegations).values({
      sourceCompanyId: sourceMission.companyId,
      sourceMissionId: sourceMission.id,
      sourceIssueId: sourceIssue.id,
      externalKey,
      targetCompanyId: targetCompany.id,
      targetMissionId: targetMission.id,
      status: "active",
      metadata: {
        ...(input.metadata ?? {}),
        title,
        targetCompanyName: targetCompany.name,
        targetOwnerAgentId: targetOwner.id,
        targetOwnerAgentName: targetOwner.name,
      },
    }).returning();

    await comment(db, {
      companyId: sourceMission.companyId,
      issueId: sourceIssue.id,
      body: [
        "Cross-company mission delegation created.",
        `- targetCompany: ${targetCompany.name}`,
        `- targetMissionId: ${targetMission.id}`,
        `- targetMissionTitle: ${targetMission.title}`,
      ].join("\n"),
    });

    return {
      delegation,
      sourceIssue,
      targetMission,
    };
  }

  async function listForMission(missionId: string) {
    return await db
      .select()
      .from(missionDelegations)
      .where(eq(missionDelegations.sourceMissionId, missionId));
  }

  async function finalizeTargetMission(input: {
    targetMissionId: string;
    targetStatus: MissionStatus;
  }): Promise<{ finalized: boolean; copiedWorkProductCount: number }> {
    if (input.targetStatus !== "completed" && input.targetStatus !== "cancelled") {
      return { finalized: false, copiedWorkProductCount: 0 };
    }

    const delegation = await db
      .select()
      .from(missionDelegations)
      .where(eq(missionDelegations.targetMissionId, input.targetMissionId))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (!delegation || delegation.status !== "active") {
      return { finalized: false, copiedWorkProductCount: 0 };
    }

    const now = new Date();
    const copiedWorkProductCount = input.targetStatus === "completed"
      ? await copyTargetMissionWorkProductsToSourceIssue(db, delegation)
      : 0;
    const nextStatus = input.targetStatus === "completed" ? "completed" : "failed";
    await db
      .update(missionDelegations)
      .set({
        status: nextStatus,
        completedAt: now,
        updatedAt: now,
      })
      .where(eq(missionDelegations.id, delegation.id));

    if (delegation.sourceIssueId) {
      await db
        .update(issues)
        .set({
          status: input.targetStatus === "completed" ? "done" : "cancelled",
          completedAt: input.targetStatus === "completed" ? now : null,
          cancelledAt: input.targetStatus === "cancelled" ? now : null,
          updatedAt: now,
        })
        .where(eq(issues.id, delegation.sourceIssueId));

      await comment(db, {
        companyId: delegation.sourceCompanyId,
        issueId: delegation.sourceIssueId,
        body: [
          `Delegated mission ${input.targetStatus}.`,
          `- targetMissionId: ${delegation.targetMissionId}`,
          `- copiedWorkProducts: ${copiedWorkProductCount}`,
        ].join("\n"),
      });
    }

    return { finalized: true, copiedWorkProductCount };
  }

  return {
    create,
    listForMission,
    finalizeTargetMission,
  };
}
