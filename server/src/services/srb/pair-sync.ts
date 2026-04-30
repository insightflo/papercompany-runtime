import { eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { issues, srbIssuePairs, srbLinks } from "@paperclipai/db";
import { heartbeatService } from "../heartbeat.js";
import { issueService } from "../issues.js";
import { applySrbInboundReceiveSideEffects, createSrbInboundHandler } from "./inbound.js";
import { logger } from "../../middleware/logger.js";
import { buildMaintenanceDecisionContext } from "../maintenance/decision-context.js";
import { logMaintenanceDecisionActionMismatch } from "../maintenance/decision-audit.js";

export type SRBPairStatusSyncMode = "blocked_only" | "mirror_source_status";

export interface SRBPairRecord {
  id: string;
  linkId: string;
  sourceCompanyId: string;
  sourceIssueId: string;
  mirrorCompanyId: string;
  mirrorIssueId: string;
  statusSyncMode: SRBPairStatusSyncMode;
  lastSyncedStatus: string | null;
  lastSyncedAt: Date | null;
  createdBy: string;
  createdAt: Date;
  updatedAt: Date;
}

export function createSrbPairSync(
  db: Db,
  deps?: {
    inbound?: Pick<ReturnType<typeof createSrbInboundHandler>, "receive">;
    heartbeat?: ReturnType<typeof heartbeatService>;
    issueSvc?: ReturnType<typeof issueService>;
  },
) {
  const inbound = deps?.inbound ?? createSrbInboundHandler(db);
  const heartbeat = deps?.heartbeat ?? heartbeatService(db);
  const issueSvc = deps?.issueSvc ?? issueService(db);

  return {
    async createLocalPairFromSourceIssue(input: {
      linkId: string;
      sourceIssueId: string;
      payload: {
        title: string;
        description?: string;
        status?: string;
        priority?: string;
        assigneeAgentId?: string | null;
      };
      createdBy: string;
      statusSyncMode?: SRBPairStatusSyncMode;
    }) {
      let transactionResult: {
        pair: SRBPairRecord;
        sourceStatus: string;
        mirrorIssueId: string;
        mirrorIssueIdentifier: string | null;
        postCommit: Awaited<ReturnType<ReturnType<typeof createSrbInboundHandler>["receive"]>>["postCommit"] | null;
      };
      try {
        transactionResult = await db.transaction(async (tx) => {
          const sourceIssue = await tx
            .select()
            .from(issues)
          .where(eq(issues.id, input.sourceIssueId))
          .then((rows) => rows[0] ?? null);
        if (!sourceIssue) {
          throw new Error(`Source issue not found: ${input.sourceIssueId}`);
        }

        const link = await tx
          .select()
          .from(srbLinks)
          .where(eq(srbLinks.id, input.linkId))
          .then((rows) => rows[0] ?? null);
        if (!link) {
          throw new Error(`SRB link not found: ${input.linkId}`);
        }
        if (link.remoteServerUrl !== null) {
          throw new Error("createLocalPairFromSourceIssue only supports same-instance SRB links");
        }
        if (link.localCompanyId !== sourceIssue.companyId) {
          throw new Error("Source issue company does not match the SRB link local company");
        }

        const existingPair = await tx
          .select()
          .from(srbIssuePairs)
          .where(eq(srbIssuePairs.linkId, input.linkId))
          .then((rows) => rows.find((row) => row.sourceIssueId === input.sourceIssueId) ?? null);
        if (existingPair) {
          const mirrorIssue = await tx
            .select({ identifier: issues.identifier })
            .from(issues)
            .where(eq(issues.id, existingPair.mirrorIssueId))
            .then((rows) => rows[0] ?? null);
          return {
            pair: existingPair as SRBPairRecord,
            sourceStatus: sourceIssue.status,
            mirrorIssueId: existingPair.mirrorIssueId,
            mirrorIssueIdentifier: mirrorIssue?.identifier ?? null,
            postCommit: null,
          };
        }

        const inboundResult = await inbound.receive(
          tx as Pick<Db, "insert" | "update" | "select" | "delete">,
          {
            linkId: input.linkId,
            targetCompanyId: link.remoteCompanyId,
            event: "issue.created",
            payload: input.payload as Record<string, unknown>,
            idempotencyKey: `srb-pair:${input.sourceIssueId}`,
          },
        );

        const now = new Date();
        const [pair] = await tx
          .insert(srbIssuePairs)
          .values({
            linkId: input.linkId,
            sourceCompanyId: sourceIssue.companyId,
            sourceIssueId: sourceIssue.id,
            mirrorCompanyId: link.remoteCompanyId,
            mirrorIssueId: inboundResult.issueId,
            statusSyncMode: input.statusSyncMode ?? "blocked_only",
            createdBy: input.createdBy,
            createdAt: now,
            updatedAt: now,
          })
          .returning();

        return {
          pair: pair as SRBPairRecord,
          sourceStatus: sourceIssue.status,
          mirrorIssueId: inboundResult.issueId,
          mirrorIssueIdentifier: inboundResult.issueIdentifier,
          postCommit: inboundResult.postCommit,
        };
        });
      } catch (error) {
        const isDuplicatePair =
          !!error &&
          typeof error === "object" &&
          "code" in error &&
          (error as { code?: string }).code === "23505" &&
          (("constraint" in error &&
            (error as { constraint?: string }).constraint === "srb_issue_pairs_unique_pair_idx") ||
            ("constraint_name" in error &&
              (error as { constraint_name?: string }).constraint_name === "srb_issue_pairs_unique_pair_idx"));
        if (!isDuplicatePair) throw error;

        const canonicalPair = await db
          .select()
          .from(srbIssuePairs)
          .where(eq(srbIssuePairs.linkId, input.linkId))
          .then((rows) => rows.find((row) => row.sourceIssueId === input.sourceIssueId) ?? null);
        if (!canonicalPair) {
          throw error;
        }
        const mirrorIssue = await db
          .select({ identifier: issues.identifier })
          .from(issues)
          .where(eq(issues.id, canonicalPair.mirrorIssueId))
          .then((rows) => rows[0] ?? null);
        const sourceIssue = await db
          .select({ status: issues.status })
          .from(issues)
          .where(eq(issues.id, input.sourceIssueId))
          .then((rows) => rows[0] ?? null);
        transactionResult = {
          pair: canonicalPair as SRBPairRecord,
          sourceStatus: sourceIssue?.status ?? "todo",
          mirrorIssueId: canonicalPair.mirrorIssueId,
          mirrorIssueIdentifier: mirrorIssue?.identifier ?? null,
          postCommit: null,
        };
      }

      if (transactionResult.postCommit) {
        await applySrbInboundReceiveSideEffects({
          db,
          heartbeat,
          postCommit: transactionResult.postCommit,
        });
      }

      const syncedPair = await this.syncSourceStatus({
        sourceIssueId: input.sourceIssueId,
        sourceStatus: transactionResult.sourceStatus,
      }).then((pairs) => pairs.find((candidate) => candidate.id === transactionResult.pair.id) ?? transactionResult.pair);

      return {
        pair: syncedPair,
        mirrorIssueId: transactionResult.mirrorIssueId,
        mirrorIssueIdentifier: transactionResult.mirrorIssueIdentifier,
      };
    },

    async syncSourceStatus(input: {
      sourceIssueId: string;
      sourceStatus: string;
    }): Promise<SRBPairRecord[]> {
      const pairs = await db
        .select()
        .from(srbIssuePairs)
        .where(eq(srbIssuePairs.sourceIssueId, input.sourceIssueId));
      const synced: SRBPairRecord[] = [];

      for (const pair of pairs) {
        if (pair.statusSyncMode !== "blocked_only" && pair.statusSyncMode !== "mirror_source_status") {
          continue;
        }
        if (pair.statusSyncMode === "blocked_only" && input.sourceStatus !== "blocked") {
          continue;
        }

        const nextMirrorStatus = input.sourceStatus;
        const mirrorIssue = await issueSvc.getById(pair.mirrorIssueId);
        if (!mirrorIssue) continue;
        if (mirrorIssue.status !== nextMirrorStatus) {
          const updatedMirrorIssue = await issueSvc.update(pair.mirrorIssueId, { status: nextMirrorStatus });
          if (updatedMirrorIssue) {
            const decision = buildMaintenanceDecisionContext({
              issue: {
                id: mirrorIssue.id,
                identifier: mirrorIssue.identifier,
                title: mirrorIssue.title,
                description: mirrorIssue.description,
                status: mirrorIssue.status,
                priority: mirrorIssue.priority,
              },
              requestedStatus: nextMirrorStatus,
              guidance: null,
            });
            if (decision) {
              await logMaintenanceDecisionActionMismatch({
                db,
                companyId: mirrorIssue.companyId,
                actor: {
                  actorType: "system",
                  actorId: "srb-status-sync",
                },
                issue: {
                  id: mirrorIssue.id,
                  identifier: mirrorIssue.identifier,
                  projectId: mirrorIssue.projectId,
                },
                decision,
                attemptedAction: "srb.mirror_status_sync",
                attemptedStatus: nextMirrorStatus,
              }).catch((err) => {
                logger.warn(
                  { err, issueId: mirrorIssue.id, sourceIssueId: input.sourceIssueId },
                  "failed to write maintenance decision action mismatch audit for SRB mirror status sync",
                );
              });
            }
            const { workflowService } = await import("../workflow/engine.js");
            await workflowService.syncRunStatusForIssue(db, updatedMirrorIssue.id);
          }
        }

        const [updatedPair] = await db
          .update(srbIssuePairs)
          .set({
            lastSyncedStatus: nextMirrorStatus,
            lastSyncedAt: new Date(),
            updatedAt: new Date(),
          })
          .where(eq(srbIssuePairs.id, pair.id))
          .returning();

        synced.push((updatedPair ?? pair) as SRBPairRecord);
      }

      return synced;
    },

    async syncBlockedStatus(input: {
      sourceIssueId: string;
      sourceStatus: string;
    }): Promise<SRBPairRecord[]> {
      return await this.syncSourceStatus(input);
    },

    async getPairsForSourceIssue(sourceIssueId: string) {
      return await db
        .select()
        .from(srbIssuePairs)
        .where(eq(srbIssuePairs.sourceIssueId, sourceIssueId));
    },

    async getPairByMirrorIssue(mirrorIssueId: string) {
      return await db
        .select()
        .from(srbIssuePairs)
        .where(eq(srbIssuePairs.mirrorIssueId, mirrorIssueId))
        .then((rows) => rows[0] ?? null);
    },
  };
}
