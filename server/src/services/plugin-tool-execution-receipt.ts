import { and, eq, lt } from "drizzle-orm";
import { pluginToolExecutionReceipts } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

/**
 * Tool execution receipt claims for `POST /api/plugins/tools/execute`.
 *
 * One receipt row per (company, run, tool, idempotency key): the unique index
 * `plugin_tool_execution_receipts_identity_uq` makes the claim insert atomic,
 * so exactly one concurrent request wins the claim and executes the tool.
 * A `completed` receipt replays its stored response instead of re-running the
 * tool's side effects (lost-HTTP-response retry safety). An `executing`
 * receipt answers in-progress while fresh and can be taken over after
 * {@link TOOL_EXECUTION_TAKEOVER_MS} so a crashed execution never silently
 * blocks the key forever.
 *
 * Only responses from real execution paths are recorded. Validation,
 * authorization, tool-not-found, and unconfigured-dispatcher outcomes never
 * complete a receipt; a claim whose request turns out not to execute at all
 * (tool not found) releases its own row so the same key stays usable.
 *
 * Key stability is the caller's responsibility: reusing one key for two
 * different logical tool calls makes the second call an unintended replay.
 *
 * @see server/src/services/plugin-webhook-receipt.ts — the sibling receipt idiom
 */

/** A claimed-but-unfinished receipt older than this may be taken over. */
export const TOOL_EXECUTION_TAKEOVER_MS = 10 * 60 * 1000;

/** Max accepted idempotencyKey length. */
export const IDEMPOTENCY_KEY_MAX_LENGTH = 200;

/** Bounded attempts to resolve a claim race before failing closed. */
const CLAIM_ATTEMPTS = 3;

/**
 * Validate and normalize a caller-supplied idempotency key, or null when the
 * value can never form a valid key (wrong type, blank, overlong).
 */
export function normalizeIdempotencyKey(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > IDEMPOTENCY_KEY_MAX_LENGTH) return null;
  return trimmed;
}

export interface ClaimToolExecutionReceiptInput {
  companyId: string;
  /** Raw runContext.runId string. */
  runId: string;
  tool: string;
  idempotencyKey: string;
  /** Original request parameters (audit copy). */
  parameters: unknown;
}

export type ToolExecutionReceiptDecision =
  | { kind: "claim"; receiptId: string }
  | { kind: "replay"; status: number; body: unknown }
  | { kind: "in-progress" };

const identityColumns = [
  pluginToolExecutionReceipts.companyId,
  pluginToolExecutionReceipts.runId,
  pluginToolExecutionReceipts.tool,
  pluginToolExecutionReceipts.idempotencyKey,
];

/**
 * Atomically claim the receipt for one logical tool call, or report what the
 * existing row dictates (replay / still in progress). Fail closed (throw) if
 * the insert/read race cannot be resolved — the caller's bounded retry path
 * re-drives the request.
 */
export async function claimToolExecutionReceipt(
  db: Db,
  input: ClaimToolExecutionReceiptInput,
): Promise<ToolExecutionReceiptDecision> {
  for (let attempt = 0; attempt < CLAIM_ATTEMPTS; attempt += 1) {
    const inserted = await db
      .insert(pluginToolExecutionReceipts)
      .values({
        companyId: input.companyId,
        runId: input.runId,
        tool: input.tool,
        idempotencyKey: input.idempotencyKey,
        status: "executing",
        requestParameters: input.parameters ?? {},
        claimedAt: new Date(),
      })
      .onConflictDoNothing({ target: identityColumns })
      .returning({ id: pluginToolExecutionReceipts.id });
    if (inserted.length > 0) return { kind: "claim", receiptId: inserted[0].id };

    const [existing] = await db
      .select({
        id: pluginToolExecutionReceipts.id,
        status: pluginToolExecutionReceipts.status,
        resultStatus: pluginToolExecutionReceipts.resultStatus,
        resultBody: pluginToolExecutionReceipts.resultBody,
        claimedAt: pluginToolExecutionReceipts.claimedAt,
      })
      .from(pluginToolExecutionReceipts)
      .where(
        and(
          eq(pluginToolExecutionReceipts.companyId, input.companyId),
          eq(pluginToolExecutionReceipts.runId, input.runId),
          eq(pluginToolExecutionReceipts.tool, input.tool),
          eq(pluginToolExecutionReceipts.idempotencyKey, input.idempotencyKey),
        ),
      );
    if (!existing) continue; // receipt vanished between conflict and read — retry

    if (existing.status === "completed") {
      // Lost HTTP response retry: replay the recorded terminal response.
      return { kind: "replay", status: existing.resultStatus ?? 500, body: existing.resultBody ?? {} };
    }

    // Concurrent execution holds a fresh claim; an abandoned one (crashed
    // execution) is taken over with a refreshed audit copy.
    const cutoff = new Date(Date.now() - TOOL_EXECUTION_TAKEOVER_MS);
    const took = await db
      .update(pluginToolExecutionReceipts)
      .set({ claimedAt: new Date(), requestParameters: input.parameters ?? {} })
      .where(
        and(
          eq(pluginToolExecutionReceipts.id, existing.id),
          eq(pluginToolExecutionReceipts.status, "executing"),
          lt(pluginToolExecutionReceipts.claimedAt, cutoff),
        ),
      )
      .returning({ id: pluginToolExecutionReceipts.id });
    if (took.length > 0) return { kind: "claim", receiptId: existing.id };
    return { kind: "in-progress" };
  }
  // Fail closed: no execution without an owned receipt.
  throw new Error(
    `Tool execution receipt race unresolved after ${CLAIM_ATTEMPTS} attempts ` +
      `(company ${input.companyId}, run ${input.runId}, tool ${input.tool}, key ${input.idempotencyKey})`,
  );
}

/**
 * Record the terminal response of a real execution on the claimed receipt.
 * The body must already be condensed (replay equals the first response).
 */
export async function completeToolExecutionReceipt(
  db: Db,
  receiptId: string,
  result: { status: number; body: unknown; workflowRunId?: string | null; stepId?: string | null },
): Promise<void> {
  await db
    .update(pluginToolExecutionReceipts)
    .set({
      status: "completed",
      resultStatus: result.status,
      resultBody: result.body ?? {},
      completedAt: new Date(),
      workflowRunId: result.workflowRunId ?? null,
      stepId: result.stepId ?? null,
    })
    .where(
      and(
        eq(pluginToolExecutionReceipts.id, receiptId),
        eq(pluginToolExecutionReceipts.status, "executing"),
      ),
    );
}

/**
 * Release this request's own claim when the request turns out not to execute
 * any tool (tool not found) so the same key remains usable for a valid call.
 * Never touches rows owned by other requests (guarded by status and id).
 */
export async function releaseToolExecutionReceipt(db: Db, receiptId: string): Promise<void> {
  await db
    .delete(pluginToolExecutionReceipts)
    .where(
      and(
        eq(pluginToolExecutionReceipts.id, receiptId),
        eq(pluginToolExecutionReceipts.status, "executing"),
      ),
    );
}
