import { operatorDecisions, type Db } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { createOperatorDecisionSchema } from "@paperclipai/shared/validators/operator-decision";
import { and, eq, like, ne } from "drizzle-orm";
import { conflict, HttpError } from "../../errors.js";
import { validateAndHashOperatorDecisionCreate } from "../operator-decision-result.js";
import { operatorDecisionWriteService } from "../operator-decisions-write.js";
import type { SystemLanguage } from "../missions/system-language.js";
import { isRecoverableQaCardUpgrade, QA_CARD_SUPERSEDED_REASON, QA_CARD_SYSTEM_ACTOR } from "./qa-source-defect-card-upgrade.js";

/** Full-payload replay candidates come only from current input or frozen, known builders. */
export async function createOrReplayQaSourceDefectCard(input: {
  db: Db;
  companyId: string;
  language: SystemLanguage;
  legacyRequestKey: string;
  v3RequestKey: string;
  sourcePrefix: string;
  build: (language: SystemLanguage) => CreateOperatorDecisionInput;
  buildHistorical: () => readonly CreateOperatorDecisionInput[];
  buildHistoricalV3: () => readonly CreateOperatorDecisionInput[];
}) {
  const preferred = input.build(input.language);
  const currentCandidates = [input.build(input.language), input.build(input.language === "ko" ? "en" : "ko")];
  const write = operatorDecisionWriteService(input.db);
  const actor = QA_CARD_SYSTEM_ACTOR;
  const load = async (requestKey: string): Promise<typeof operatorDecisions.$inferSelect | null> => input.db.select().from(operatorDecisions).where(and(
    eq(operatorDecisions.companyId, input.companyId),
    eq(operatorDecisions.requestKey, requestKey),
  )).then((rows) => rows[0] ?? null);
  const conflictFor = (row: typeof operatorDecisions.$inferSelect) =>
    conflict("Operator decision request key conflict", { operatorDecisionId: row.id, status: row.status });
  const matchingInput = (
    row: typeof operatorDecisions.$inferSelect,
    candidates: readonly CreateOperatorDecisionInput[],
  ) => {
    if (row.companyId !== input.companyId || row.sourceType !== preferred.sourceType || row.sourceId !== preferred.sourceId) {
      throw conflictFor(row);
    }
    for (const raw of candidates) {
      const parsed = createOperatorDecisionSchema.safeParse({ ...raw, requestKey: row.requestKey });
      if (!parsed.success) continue;
      const candidate = validateAndHashOperatorDecisionCreate(parsed.data);
      if (candidate.requestHash === row.requestHash) return candidate.input;
    }
    throw conflictFor(row);
  };
  const cleanup = async (requestKey: string, sameGenerationKeys: readonly string[] = []) => {
    const staleRows = await input.db.select({ id: operatorDecisions.id }).from(operatorDecisions).where(and(
      eq(operatorDecisions.companyId, input.companyId),
      eq(operatorDecisions.sourceType, preferred.sourceType),
      eq(operatorDecisions.status, "pending"),
      like(operatorDecisions.sourceId, input.sourcePrefix),
      ne(operatorDecisions.requestKey, requestKey),
      ...sameGenerationKeys.map((key) => ne(operatorDecisions.requestKey, key)),
    ));
    for (const stale of staleRows) await write.cancel(stale.id, actor, QA_CARD_SUPERSEDED_REASON);
  };
  const replay = async (
    row: typeof operatorDecisions.$inferSelect,
    candidates: readonly CreateOperatorDecisionInput[],
  ) => {
    const candidate = matchingInput(row, candidates); // An identity conflict must not clean other rows.
    await cleanup(row.requestKey);
    return write.create(input.companyId, candidate, actor);
  };
  const recoverable = (row: typeof operatorDecisions.$inferSelect) => isRecoverableQaCardUpgrade(input.db, row, {
    companyId: input.companyId, requestKey: input.legacyRequestKey,
    sourceType: preferred.sourceType, sourceId: preferred.sourceId,
  });

  // A v3 decision is an immutable identity record, including human terminal choices.
  const historicalV3 = await load(input.v3RequestKey);
  if (historicalV3) {
    const candidates = input.buildHistoricalV3();
    if (!candidates.some((candidate) => candidate.requestKey === input.v3RequestKey)) throw conflictFor(historicalV3);
    const original = matchingInput(historicalV3, candidates);
    const current = await load(preferred.requestKey);
    if (current) {
      matchingInput(current, currentCandidates);
      throw conflict("Both v3 and v4 QA source defect cards exist for one producer generation", {
        historicalDecisionId: historicalV3.id, currentDecisionId: current.id,
      });
    }
    await cleanup(historicalV3.requestKey, [preferred.requestKey, input.legacyRequestKey]);
    return write.create(input.companyId, original, actor);
  }

  // Keep the current key precedence and the established unversioned upgrade/receipt path.
  const current = await load(preferred.requestKey);
  if (current) return replay(current, currentCandidates);
  let legacy = await load(input.legacyRequestKey);
  if (legacy?.status === "pending") {
    if (legacy.companyId !== input.companyId || legacy.sourceType !== preferred.sourceType || legacy.sourceId !== preferred.sourceId) {
      throw conflictFor(legacy);
    }
    let applied = false;
    try {
      ({ applied } = await write.cancel(legacy.id, actor, QA_CARD_SUPERSEDED_REASON));
    } catch (error) {
      if (!(error instanceof HttpError) || error.status !== 409) throw error;
    }
    if (!applied) {
      const winner = await load(preferred.requestKey);
      if (winner) return replay(winner, currentCandidates);
      legacy = await load(input.legacyRequestKey);
      if (!legacy || legacy.status === "pending") throw conflict("Operator decision conflict");
    } else {
      legacy = null;
    }
  }
  if (legacy) {
    if (!await recoverable(legacy)) return replay(legacy, [...currentCandidates, ...input.buildHistorical()]);
    matchingInput(legacy, [...currentCandidates, ...input.buildHistorical()]);
  }

  await cleanup(preferred.requestKey);
  try {
    return await write.create(input.companyId, preferred, actor);
  } catch (error) {
    if (!(error instanceof HttpError) || error.status !== 409) throw error;
    const winner = await load(preferred.requestKey);
    if (winner) return replay(winner, currentCandidates);
    throw error;
  }
}
