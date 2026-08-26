import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { workflowDefinitions } from "@paperclipai/db";
import { stableStringify } from "../issue-execution-cards/hash.js";
import type { WorkflowStep } from "./dag-engine.js";
import { workflowService } from "./engine.js";

/**
 * [Stage 4] PAQO definition immutability — deterministic identity.
 *
 * Canonical definition hash algorithm (FROZEN):
 *   sha256( stableStringify({ schemaVersion: 1, steps }) )
 * - `steps` is the exact built step array that defines execution semantics
 *   (agents, tools, dependencies, descriptions, gates). Volatile fields
 *   (timestamps, row ids, names for display) are excluded by construction
 *   because they are not part of the step payload.
 * - stableStringify recursively sorts object keys, so key insertion order
 *   never changes the hash.
 * - Any future change to the hash input MUST bump `schemaVersion`; by design
 *   that changes every subsequently computed hash and therefore produces new
 *   immutable definitions rather than silently aliasing old ones.
 */
const PAQO_DEFINITION_HASH_SCHEMA_VERSION = 1;

export type PaqoWorkflowDefinitionRow = typeof workflowDefinitions.$inferSelect;

export function computePaqoDefinitionHash(steps: WorkflowStep[]): string {
  const canonical = stableStringify({
    schemaVersion: PAQO_DEFINITION_HASH_SCHEMA_VERSION,
    steps,
  });
  return createHash("sha256").update(canonical).digest("hex");
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}

async function findPaqoDefinitionByTriple(
  db: Db,
  input: { companyId: string; missionId: string; definitionHash: string },
): Promise<PaqoWorkflowDefinitionRow | null> {
  const [row] = await db
    .select()
    .from(workflowDefinitions)
    .where(
      and(
        eq(workflowDefinitions.companyId, input.companyId),
        eq(workflowDefinitions.sourceKind, "paqo"),
        eq(workflowDefinitions.missionId, input.missionId),
        eq(workflowDefinitions.definitionHash, input.definitionHash),
      ),
    )
    .limit(1);
  return row ?? null;
}

/**
 * Immutable PAQO definition lifecycle:
 * - exact (company_id, mission_id, definition_hash) match with
 *   source_kind='paqo' -> idempotently reuse that definition
 * - no match -> create a NEW definition (mission_id, definition_hash,
 *   source_kind='paqo'); existing definitions are NEVER updated
 * - concurrent insert race is resolved by the partial unique index
 *   workflow_definitions_paqo_identity_uq: catch unique violation, re-fetch,
 *   reuse
 * - legacy null-hash rows can never match (lookup requires the exact
 *   non-null hash), so they stay read-only forever
 */
export async function findOrCreateImmutablePaqoWorkflowDefinition(
  db: Db,
  input: {
    companyId: string;
    missionId: string;
    name: string;
    steps: WorkflowStep[];
  },
): Promise<PaqoWorkflowDefinitionRow | null> {
  const definitionHash = computePaqoDefinitionHash(input.steps);
  const existing = await findPaqoDefinitionByTriple(db, { ...input, definitionHash });
  if (existing) return existing;

  try {
    await workflowService.createDefinition(db, {
      companyId: input.companyId,
      name: input.name,
      steps: input.steps,
      source: "native",
      sourceKind: "paqo",
      missionId: input.missionId,
      definitionHash,
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  // Re-fetch by the identity triple so callers always get the canonical DB
  // row — this also collapses the concurrent-insert race into a reuse.
  const settled = await findPaqoDefinitionByTriple(db, { companyId: input.companyId, missionId: input.missionId, definitionHash });
  if (settled) return settled;
  throw new Error(`PAQO definition insert did not settle for mission ${input.missionId} hash ${definitionHash}`);
}
