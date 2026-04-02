import type { Db } from "@paperclipai/db";
import { createSRBRouter, type SRBRoutingInput } from "./router.js";
import { createSrbInboundHandler } from "./inbound.js";

export interface SRBLocalDispatchResult {
  path: "local";
  deliveryId: string;
  issueId: string;
  issueIdentifier: string | null;
  status: "received";
}

export function createLocalDispatch(db: Db) {
  const router = createSRBRouter(db);
  const inbound = createSrbInboundHandler(db);

  return {
    async dispatch(input: SRBRoutingInput): Promise<SRBLocalDispatchResult> {
      const route = await router.route(input);
      if (route.path !== "local") {
        throw new Error(`SRB link ${input.linkId} does not route to the local path`);
      }

      const result = await db.transaction(async (tx) =>
        await inbound.receive(tx as Pick<Db, "insert" | "update" | "select" | "delete">, {
          linkId: route.linkId,
          targetCompanyId: route.remoteCompanyId,
          event: input.event,
          payload: input.payload,
          idempotencyKey: input.idempotencyKey,
        })
      );

      return {
        path: "local",
        ...result,
      };
    },
  };
}
