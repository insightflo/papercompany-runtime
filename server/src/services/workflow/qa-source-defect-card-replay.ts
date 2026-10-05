import { operatorDecisions, type Db } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { createOperatorDecisionSchema } from "@paperclipai/shared/validators/operator-decision";
import { and, eq, like, ne } from "drizzle-orm";
import { conflict, HttpError } from "../../errors.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";
import type { SystemLanguage } from "../missions/system-language.js";
import { isRecoverableQaCardUpgrade, QA_CARD_SUPERSEDED_REASON, QA_CARD_SYSTEM_ACTOR } from "./qa-source-defect-card-upgrade.js";

/** Replay only a full hash reconstructed from the caller's inputs and a known
 * producer contract. Never infer language/findings/upgrade intent from card prose.
 */
export async function createOrReplayQaSourceDefectCard(input: {
  db: Db;
  companyId: string;
  language: SystemLanguage;
  legacyRequestKey: string;
  sourcePrefix: string;
  build: (language: SystemLanguage) => CreateOperatorDecisionInput;
  buildHistorical: () => CreateOperatorDecisionInput;
}) {
  const preferred = input.build(input.language);
  // Keep the shared writer on the root DB: creation is published after its commit.
  const write = operatorDecisionWriteService(input.db);
  const actor = QA_CARD_SYSTEM_ACTOR;
  const load = async (requestKey: string): Promise<typeof operatorDecisions.$inferSelect | null> => input.db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    eq(operatorDecisions.requestKey, requestKey),
  )).then((rows) => rows[0] ?? null);
  const matchingInput = (row: typeof operatorDecisions.$inferSelect) => {
    const candidates = [input.build(input.language), input.build(input.language === "ko" ? "en" : "ko")];
    if (row.requestKey === input.legacyRequestKey) candidates.push(input.buildHistorical());
    for (const raw of candidates) {
      const parsed = createOperatorDecisionSchema.safeParse({ ...raw, requestKey: row.requestKey });
      // The alternate language may exceed a display limit while the original is valid.
      if (!parsed.success) continue;
      const candidate = validateAndHashOperatorDecisionCreate(parsed.data);
      if (candidate.requestHash === row.requestHash) return candidate.input;
    }
    throw conflict("Operator decision request key conflict", { operatorDecisionId: row.id, status: row.status });
  };
  const cleanup = async (requestKey: string) => {
    // Preserve the existing selection; only the validated replay target is excluded.
    const staleRows = await input.db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, input.companyId),
      eq(operatorDecisions.sourceType, preferred.sourceType),
      eq(operatorDecisions.status, "pending"),
      like(operatorDecisions.sourceId, input.sourcePrefix),
      ne(operatorDecisions.requestKey, requestKey),
    ));
    for (const stale of staleRows) await write.cancel(stale.id, actor, QA_CARD_SUPERSEDED_REASON);
  };
  const replay = async (row: typeof operatorDecisions.$inferSelect) => {
    const candidate = matchingInput(row); // Conflict must not cancel any stale cards.
    await cleanup(row.requestKey);
    return write.create(input.companyId, candidate, actor);
  };
  const recoverable = (row: typeof operatorDecisions.$inferSelect) => isRecoverableQaCardUpgrade(input.db, row, {
    companyId: input.companyId, requestKey: input.legacyRequestKey,
    sourceType: preferred.sourceType, sourceId: preferred.sourceId,
  });

  // Current version wins over legacy cancellation by a completed upgrade.
  const current = await load(preferred.requestKey);
  if (current) return replay(current);
  let legacy = await load(input.legacyRequestKey);
  if (legacy?.status === "pending") {
    // A caller-supplied key is not authority to cancel a different source's card.
    if (legacy.companyId !== input.companyId || legacy.sourceType !== preferred.sourceType || legacy.sourceId !== preferred.sourceId) {
      throw conflict("Operator decision request key conflict", { operatorDecisionId: legacy.id, status: legacy.status });
    }
    // Human terminal decisions and another upgrader can win the pending -> cancelled
    // CAS. Re-read that winner rather than treating applied:false/409 as permission.
    let applied = false;
    try {
      ({ applied } = await write.cancel(legacy.id, actor, QA_CARD_SUPERSEDED_REASON));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
    if (!applied) {
      const winner = await load(preferred.requestKey);
      if (winner) return replay(winner);
      legacy = await load(input.legacyRequestKey);
      if (!legacy || legacy.status === "pending") throw conflict("Operator decision conflict");
    } else {
      // This caller committed the upgrade cancellation; creation may now proceed.
      legacy = null;
    }
  }
  if (legacy) {
    if (!await recoverable(legacy)) return replay(legacy);
    // A durable system upgrade receipt permits retrying the missing replacement,
    // but never permits adopting changed domain inputs or an unknown historical hash.
    matchingInput(legacy);
  }

  await cleanup(preferred.requestKey);
  try {
    return await write.create(input.companyId, preferred, actor);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    // The unique key chooses the first language, retaining full domain-input checks.
    const winner = await load(preferred.requestKey);
    if (winner) return replay(winner);
    throw error;
  }
}
