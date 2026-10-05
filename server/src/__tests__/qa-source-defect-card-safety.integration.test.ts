import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { companies, createDb, operatorDecisions } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import * as systemLanguage from "../services/missions/system-language.js";
import { logger } from "../middleware/logger.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { FINDINGS_SOURCE_ONLY, seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip QA card safety tests: ${support.reason ?? "unsupported"}`);

describeDb("QA card deploy and display safety", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | undefined;
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-card-safety-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function scenario() {
    const seed = await seedQaSourceDefectScenario(db, FINDINGS_SOURCE_ONLY);
    return {
      db, companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings: FINDINGS_SOURCE_ONLY,
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: null,
    };
  }
  async function persisted(input: Parameters<typeof ensureQaSourceDefectOwnerCard>[0]) {
    const result = await ensureQaSourceDefectOwnerCard(input);
    expect(result.outcome, JSON.stringify(result)).toBe("created");
    if (result.outcome !== "created") throw new Error(`Unexpected outcome: ${JSON.stringify(result)}`);
    const [card] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, result.decisionId));
    return card!;
  }

  // An unversioned request key reuses changed content and conflicts instead of superseding.
  it("supersedes a legacy pending card with changed definition and replays the new version", async () => {
    const input = await scenario();
    const legacy = await persisted(input);
    await db.update(operatorDecisions).set({
      requestKey: `qa-source-defect:${input.workflowRunId}:produce:0`,
      requestHash: "legacy-template-hash",
      title: "Legacy QA card wording",
    }).where(eq(operatorDecisions.id, legacy.id));
    const current = await persisted(input);
    expect(current.requestKey).toBe(`qa-source-defect:v2:${input.workflowRunId}:produce:0`);
    expect(current.id).not.toBe(legacy.id);
    const [old] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, legacy.id));
    expect(old!.status).toBe("cancelled");
    expect(old!.cancelledAt).toBeInstanceOf(Date);
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: current.id });
    const rows = await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, input.companyId));
    expect(rows).toHaveLength(2);
    expect(rows.filter(({ status }) => status === "pending").map(({ id }) => id)).toEqual([current.id]);
  });

  // Removing catch would reject the whole card when only display-language lookup fails.
  it("creates an English card and warns when company language lookup fails", async () => {
    const input = await scenario();
    await db.update(companies).set({ defaultLanguage: "ko" }).where(eq(companies.id, input.companyId));
    const error = new Error("injected language lookup unavailable");
    vi.spyOn(systemLanguage, "loadCompanySystemLanguage").mockRejectedValueOnce(error);
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
    const card = await persisted(input);
    expect(card.title).toBe("Quality review (QA) rejected — source data defects, choose next steps (produce · rework 0/2)");
    expect(card.definition.options[0]!.label).toBe("Run data collection again");
    expect(warn).toHaveBeenCalledWith(expect.objectContaining({ err: error, companyId: input.companyId }), expect.any(String));
  });

  // A raw UTF-16 slice leaves half an emoji, which PostgreSQL persists as U+FFFD.
  it.each(["label", "fact", "evidence", "interpretation", "description"] as const)(
    "%s keeps the longest UTF-16 prefix without splitting a surrogate pair", async (field) => {
      const input = await scenario();
      const line = "- [source_data] (f) ";
      const interpretationPrefix = "Quality review (QA) submitted a structured 'changes needed' verdict with findings.\n"
        + "All rejection reasons concern source data: the original material from the collection stage. Rebuilding the output cannot fix it, so human judgment is requested instead of automatic producer rework.\n\nFindings:\n" + line;
      const descriptionPrefix = "## Quality review (QA) rejected — choose how to proceed\n\n"
        + "Producer: step `produce` (rework 0/2)\n" + `Workflow run: ${input.workflowRunId}\n\n`
        + "Quality review requested changes. Choose an action based on the submitted defect findings.\n\nFindings:\n" + line;
      const prefix = { label: "Finding ", fact: "[source_data] ", evidence: line,
        interpretation: interpretationPrefix, description: descriptionPrefix }[field];
      const limit = { label: 80, fact: 200, evidence: 1000, interpretation: 4000, description: 4000 }[field];
      const payload = "a".repeat(limit - prefix.length - 1) + "😀END";
      const finding = { id: field === "label" ? payload : "f", summary: payload, layer: "source_data" as const };
      const card = await persisted({ ...input, findings: [finding] });
      const review = card.definition.humanReview!;
      const actual = { label: card.definition.options[0]!.facts[2]!.label,
        fact: card.definition.options[0]!.facts[2]!.value, evidence: review.evidence[0]!.description,
        interpretation: review.interpretation, description: card.description }[field];
      expect(actual).toBe(prefix + "a".repeat(limit - prefix.length - 1));
      expect(actual!.length).toBe(limit - 1);
      expect(actual).not.toContain("\uFFFD");
    });

  it("retains an entire emoji when it fits exactly in the fact limit", async () => {
    const input = await scenario();
    const summary = "a".repeat(184) + "😀END";
    const card = await persisted({ ...input, findings: [{ id: "f", summary, layer: "source_data" }] });
    expect(card.definition.options[0]!.facts[2]!.value).toBe("[source_data] " + "a".repeat(184) + "😀");
    expect(card.definition.options[0]!.facts[2]!.value.length).toBe(200);
  });
});
