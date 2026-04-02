import type { Db } from "@paperclipai/db";
import { createIssueSchema } from "@paperclipai/shared";
import { issueService } from "../issues.js";
import { insertSrbDeliveryLog } from "./shared.js";

type SrbInboundDb = Pick<Db, "insert" | "update" | "select" | "delete">;

export interface SRBInboundReceiveResult {
  deliveryId: string;
  issueId: string;
  issueIdentifier: string | null;
  status: "received";
}

export function createSrbInboundHandler(db: Db) {
  const issuesSvc = issueService(db);

  return {
    async receive(
      dbOrTx: SrbInboundDb,
      input: {
        linkId: string;
        targetCompanyId: string;
        event: string;
        payload: Record<string, unknown>;
        idempotencyKey: string;
      },
    ): Promise<SRBInboundReceiveResult> {
      const parsed = createIssueSchema.safeParse(input.payload);
      if (!parsed.success) {
        throw new Error("SRB payload must match the issue-create shape");
      }

      const issue = await issuesSvc.createFromSrb(dbOrTx, input.targetCompanyId, {
        ...parsed.data,
        originKind: "srb",
        originId: `${input.linkId}:${input.idempotencyKey}`,
      });

      const delivery = await insertSrbDeliveryLog(dbOrTx, {
        linkId: input.linkId,
        event: input.event,
        payload: input.payload,
        idempotencyKey: input.idempotencyKey,
        status: "received",
        attemptCount: 1,
        lastAttemptAt: new Date(),
        nextRetryAt: null,
      });

      return {
        deliveryId: delivery.id,
        issueId: issue.id,
        issueIdentifier: issue.identifier,
        status: "received",
      };
    },
  };
}
