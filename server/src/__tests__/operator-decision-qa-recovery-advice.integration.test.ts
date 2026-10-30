import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog, agentWakeupRequests, createDb, issueComments, issueWorkProducts, issues,
  operatorDecisionContinuations, operatorDecisions, workflowRuns, workflowStepInvocations,
  workflowDefinitions, workflowStepRuns, workflowTransitionEvents,
} from "@paperclipai/db";
import { and, eq, inArray } from "drizzle-orm";
import type { HistoricalQaSourceDefectCardIdentityInput } from "../services/workflow/qa-source-defect-card-historical-v3.js";
import { buildHistoricalV3Candidates } from "../services/workflow/qa-source-defect-card-historical-v3.js";
import { buildCardCreateInput } from "../services/workflow/qa-source-defect-owner-card.js";
import { captureExecutionDefinition } from "../services/workflow/execution-definition.js";
import { loadOperatorDecisionProjections } from "../services/operator-decision-view.js";
import { loadQaRecoveryAdviceFacts } from "../services/operator-decision-qa-recovery-advice.js";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";
import { seedLaterQaPass } from "./helpers/qa-recovery-currentness-fixtures.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const artifactFindings = [
  { id: "F2", layer: "artifact" as const, summary: "blocks[3] still ends with banned phrase '...독자에게 쓸모가 있다.' ('쓸모 있다' wording banned; same defect). Fix: reword ending without '쓸모', e.g. '...독자에게 유용하다.'" },
  { id: "F3", layer: "artifact" as const, summary: "blocks[13]·[14] figures (73회·2.90→3.03배 / 1.2배·36/47·0.86~0.99배·3.01·3.44배·30.3/13.4 tok/s) lack same-sentence '(YYYY-MM-DD 기준)' date (GEO rule 3); 0 occurrences in file, and blocks[30]·[2] batch notes do not substitute. Fix: append '(2026-10-29 기준)' beside the figures in both blocks." },
];
const sourceFindings = [
  { id: "S1", layer: "source_data" as const, summary: "The collected source material is incomplete." },
];
const writerActor = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip historical QA advice integration: ${support.reason}`);

describeDb("historical QA cause advice uses current structured facts", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("operator-decision-qa-advice-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function seedHistoricalCard(input: {
    findings: typeof artifactFindings | typeof sourceFindings;
    addFrozenDefinition?: boolean;
    linkIssueId?: string;
    missionId?: string;
    workflowRunId?: string;
    requestKey?: string;
    withSkippedFinalQa?: boolean;
  }) {
    const seed = await seedQaSourceDefectScenario(db, input.findings, { priorFindings: input.findings });
    if (input.withSkippedFinalQa) {
      const [run] = await db.select({ workflowId: workflowRuns.workflowId }).from(workflowRuns)
        .where(eq(workflowRuns.id, seed.runId));
      const steps = structuredClone(seed.steps) as unknown as Array<Record<string, unknown>>;
      const producer = steps.find((step) => step.id === "produce");
      if (!run || !producer) throw new Error("two-backedge fixture producer was not found");
      const edges = Array.isArray(producer.conditionalDependencies) ? producer.conditionalDependencies : [];
      producer.conditionalDependencies = [...edges, {
        stepId: "qa-final", when: "qa_request_changes", isBackEdge: true, maxIterations: 2,
      }];
      steps.push({ id: "qa-final", name: "Final QA", type: "agent", agentId: seed.ownerId, dependencies: ["qa-validate"] });
      await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, run.workflowId));
      await db.insert(workflowStepRuns).values({ workflowRunId: seed.runId, stepId: "qa-final", status: "skipped",
        completedAt: new Date(), metadata: { controlFlowSkipped: true } });
    }
    if (input.addFrozenDefinition !== false) {
      await db.update(workflowRuns).set({ status: "pending", metadata: { executionDefinitionVersion: 1 } })
        .where(eq(workflowRuns.id, seed.runId));
      await db.transaction((tx) => captureExecutionDefinition(tx, seed.runId));
      await db.update(workflowRuns).set({ status: "running" }).where(eq(workflowRuns.id, seed.runId));
    }
    await db.update(workflowStepRuns).set({ completedAt: new Date() }).where(and(
      eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-validate"),
    ));
    const identity: HistoricalQaSourceDefectCardIdentityInput = {
      workflowRunId: input.workflowRunId ?? seed.runId, producerStepId: "produce", iteration: 0, maxIterations: 2,
      findings: input.findings, qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }],
      missionId: input.missionId ?? seed.missionId, linkIssueId: input.linkIssueId ?? seed.oversightIssueId,
    };
    const oldV3Card = buildHistoricalV3Candidates(identity, input.findings.map((finding) => finding.id))
      .find((card) => card.title.startsWith("Quality review")
        && (input.findings[0]!.layer === "artifact"
          ? String(card.definition.humanReview?.evidence[0]?.description).includes("source_data*")
          : card.definition.options.some((option) => option.id === "rerun_source_collection" && option.recommended)));
    if (!oldV3Card) throw new Error("frozen v3 candidate fixture was not produced");
    const candidate = input.requestKey ? { ...oldV3Card, requestKey: input.requestKey } : oldV3Card;
    const created = await operatorDecisionWriteService(db).create(seed.companyId, candidate, writerActor);
    const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, created.decision.id));
    return { seed, identity, oldV3Card, row: row! };
  }

  async function effects(companyId: string) {
    return {
      decisions: await db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId)),
      activity: await db.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
      continuations: await db.select().from(operatorDecisionContinuations).where(eq(operatorDecisionContinuations.companyId, companyId)),
      comments: await db.select().from(issueComments).where(eq(issueComments.companyId, companyId)),
      wakeups: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
      runs: await db.select().from(workflowRuns).where(eq(workflowRuns.companyId, companyId)),
      steps: await db.select().from(workflowStepRuns).where(inArray(workflowStepRuns.workflowRunId,
        db.select({ id: workflowRuns.id }).from(workflowRuns).where(eq(workflowRuns.companyId, companyId)))),
      issues: await db.select().from(issues).where(eq(issues.companyId, companyId)),
      events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, companyId)),
      invocations: await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.companyId, companyId)),
      products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, companyId)),
    };
  }

  it("corrects the full artifact-only projection and denies a stale collection submission without effects", async () => {
    const { seed, row } = await seedHistoricalCard({ findings: artifactFindings });
    const saved = structuredClone(row);
    const advice = (await loadQaRecoveryAdviceFacts(db, [row])).get(row.id)!;
    expect(advice).toMatchObject({ disposition: "verified", cause: "artifact_only", collectionChoiceAllowed: false });
    const [loaded] = await loadOperatorDecisionProjections(db, [row]);
    const projection = loaded!.view;
    expect(projection.title).toContain("artifact");
    expect(projection.description).toContain("Current official QA cause");
    expect(projection.description).toContain("[artifact] (F2)");
    expect(projection.description).toContain("[artifact] (F3)");
    expect(projection.description).not.toContain("source_data*");
    expect(projection.definition.humanReview!.interpretation).not.toContain("producer cannot fix");
    expect(projection.definition.options.map((option) => option.id)).toEqual(row.definition.options.map((option) => option.id));
    expect(projection.definition.options.map((option) => option.evidenceRefs)).toEqual(row.definition.options.map((option) => option.evidenceRefs));
    expect(projection.definition.actions).toEqual(row.definition.actions);
    expect(projection.definition.options.every((option) => !option.recommended && !option.recommendationReason)).toBe(true);
    expect(projection.definition.options.every((option) => option.facts?.every((fact) => !fact.value.includes("source_data*")))).toBe(true);
    expect(projection.definition.humanReview!.evidence.map(({ href, location }) => ({ href, location })))
      .toEqual(row.definition.humanReview!.evidence.map(({ href, location }) => ({ href, location })));
    expect(projection.definition.approvedScope).toEqual(row.definition.approvedScope);
    expect(projection.definition.forbiddenScope).toEqual(row.definition.forbiddenScope);
    expect((await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, row.id)))[0]).toEqual(saved);

    const before = await effects(seed.companyId);
    const result = await operatorDecisionWriteService(db).resolve(row.id, {
      actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "stale client selection",
    }, "human").then(() => null, (error: unknown) => error);
    expect(result).toMatchObject({ status: 409, details: {
      code: "qa_recovery_collection_choice_unproven", operatorDecisionId: row.id,
    } });
    expect(await effects(seed.companyId)).toEqual(before);
  });

  it("replays an equal resolved choice without adding another audit, continuation, or comment", async () => {
    const { seed, row } = await seedHistoricalCard({ findings: artifactFindings });
    const selection = { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: "keep the completed work" };
    const writer = operatorDecisionWriteService(db);
    const first = await writer.resolve(row.id, selection, "human");
    expect(first.applied).toBe(true);
    const afterFirst = await effects(seed.companyId);
    const replay = await writer.resolve(row.id, selection, "human");
    expect(replay.applied).toBe(false);
    expect(await effects(seed.companyId)).toEqual(afterFirst);
  });

  it("preserves a native hold action without starting work for a historical card", async () => {
    const { seed, row } = await seedHistoricalCard({ findings: artifactFindings });
    const before = await effects(seed.companyId);
    const result = await operatorDecisionWriteService(db).resolve(row.id, {
      actionId: "dismiss", selectedOptionIds: [], comment: "hold for human review",
    }, "human");
    expect(result.applied).toBe(true);
    expect(result.decision.result?.outcome).toBe("hold");
    const after = await effects(seed.companyId);
    expect(after.runs).toEqual(before.runs);
    expect(after.steps).toEqual(before.steps);
    expect(after.events).toEqual(before.events);
  });

  it("keeps a verified exact source-only direction distinct from the QA and oversight records", async () => {
    const { seed, row } = await seedHistoricalCard({ findings: sourceFindings });
    const advice = (await loadQaRecoveryAdviceFacts(db, [row])).get(row.id)!;
    expect(advice).toMatchObject({ disposition: "verified", cause: "source_only", sourceIssueId: expect.any(String), collectionChoiceAllowed: true });
    const before = await effects(seed.companyId);
    const resolution = await operatorDecisionWriteService(db).resolve(row.id, {
      actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "human direction only",
    }, "human");
    expect(resolution.applied).toBe(true);
    expect(resolution.decision.id).toBe(row.id);
    expect(resolution.decision.issueId).toBe(seed.oversightIssueId);
    expect(resolution.decision.issueId).not.toBe(seed.producerIssueId);
    expect(resolution.continuation).toBeTruthy();
    const after = await effects(seed.companyId);
    expect(after.runs).toEqual(before.runs);
    expect(after.steps).toEqual(before.steps);
    expect(after.events).toEqual(before.events);
  });

  it("preserves a canonical v4 source direction for the existing native continuation path", async () => {
    const { seed, identity } = await seedHistoricalCard({ findings: sourceFindings });
    const currentV4Card = buildCardCreateInput({ ...identity, language: "en", recurringFindingIds: ["S1"] });
    const { decision } = await operatorDecisionWriteService(db).create(seed.companyId, currentV4Card, writerActor);
    expect(decision.requestKey).toContain(":v4:");
    const before = await effects(seed.companyId);
    const resolved = await operatorDecisionWriteService(db).resolve(decision.id, {
      actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "preserve native v4 direction",
    }, "human");
    expect(resolved.applied).toBe(true);
    expect(resolved.continuation).toBeTruthy();
    const after = await effects(seed.companyId);
    expect(after.runs).toEqual(before.runs);
    expect(after.steps).toEqual(before.steps);
    expect(after.events).toEqual(before.events);
  });

  it("uses the rejected QA while excluding a positively skipped final QA", async () => {
    const { row } = await seedHistoricalCard({ findings: artifactFindings, withSkippedFinalQa: true });
    const advice = (await loadQaRecoveryAdviceFacts(db, [row])).get(row.id)!;
    expect(advice).toMatchObject({ disposition: "verified", cause: "artifact_only", collectionChoiceAllowed: false });
  });

  it.each(["missing", "marked-skipped-with-start-record", "pending", "running", "unmarked-skip", "issue-backed-no-verdict"] as const)(
    "keeps %s final QA unproven", async (kind) => {
      const { seed, row } = await seedHistoricalCard({ findings: artifactFindings, withSkippedFinalQa: true });
      const where = and(eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "qa-final"));
      if (kind === "missing") await db.delete(workflowStepRuns).where(where);
      else {
        const patch: Partial<typeof workflowStepRuns.$inferInsert> = { metadata: { controlFlowSkipped: true } };
        if (kind === "marked-skipped-with-start-record") { patch.status = "skipped"; patch.startedAt = new Date(); }
        if (kind === "pending") { patch.status = "pending"; patch.completedAt = null; }
        if (kind === "running") { patch.status = "running"; patch.startedAt = new Date(); patch.completedAt = null; }
        if (kind === "unmarked-skip") { patch.status = "skipped"; patch.metadata = {}; }
        if (kind === "issue-backed-no-verdict") {
          patch.status = "completed"; patch.issueId = seed.qaIssueId; patch.completedAt = new Date(); patch.metadata = {};
        }
        await db.update(workflowStepRuns).set(patch).where(where);
      }
      expect((await loadQaRecoveryAdviceFacts(db, [row])).get(row.id)).toMatchObject({ disposition: "unproven" });
      if (kind === "marked-skipped-with-start-record") {
        const [loaded] = await loadOperatorDecisionProjections(db, [row]);
        expect(loaded!.view.title).toContain("unverified");
        expect(loaded!.view.definition.options.every((option) => !option.recommended && !option.recommendationReason)).toBe(true);
        const before = await effects(seed.companyId);
        const originalCard = before.decisions.find((decision) => decision.id === row.id);
        expect(originalCard).toMatchObject({ id: row.id, requestHash: row.requestHash, result: row.result });
        const denied = await operatorDecisionWriteService(db).resolve(row.id, {
          actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: "started skip remains unproven",
        }, "human").then(() => null, (error: unknown) => error);
        expect(denied).toMatchObject({ status: 409, details: {
          code: "qa_recovery_collection_choice_unproven", operatorDecisionId: row.id,
        } });
        const after = await effects(seed.companyId);
        expect(after.decisions.find((decision) => decision.id === row.id)).toEqual(originalCard);
        expect(after.steps).toEqual(before.steps);
        expect(after).toEqual(before);
      }
    },
  );

  it("holds an unfrozen v3 card unproven rather than guessing from saved recommendations", async () => {
    const { row } = await seedHistoricalCard({ findings: artifactFindings, addFrozenDefinition: false });
    const advice = (await loadQaRecoveryAdviceFacts(db, [row])).get(row.id)!;
    expect(advice).toMatchObject({ disposition: "unproven" });
    const [loaded] = await loadOperatorDecisionProjections(db, [row]);
    expect(loaded!.view.title).toContain("unverified");
    expect(loaded!.view.description).toContain("could not be matched");
    expect(loaded!.view.definition.options.every((option) => !option.recommended && !option.recommendationReason)).toBe(true);
  });

  it.each(["custom-key", "custom-v4-key", "full-hash-mismatch", "cross-scope", "malformed-run-id", "later-pass", "new-generation"] as const)(
    "holds %s historical identity without falling back to saved prose", async (kind) => {
      const { seed, row: createdRow } = await seedHistoricalCard({
        findings: artifactFindings,
        ...(kind === "custom-key" ? { requestKey: "custom:qa-source-defect:v3:untrusted" } : {}),
        ...(kind === "custom-v4-key" ? { requestKey: "qa-source-defect:v4:custom:0" } : {}),
        ...(kind === "cross-scope" ? { missionId: randomUUID() } : {}),
        ...(kind === "malformed-run-id" ? { workflowRunId: "not-a-uuid" } : {}),
      });
      if (kind === "full-hash-mismatch") {
        await db.update(operatorDecisions).set({ requestHash: "f".repeat(64) })
          .where(eq(operatorDecisions.id, createdRow.id));
      }
      if (kind === "new-generation") {
        await db.update(workflowStepRuns).set({ iterationIndex: 1 }).where(and(
          eq(workflowStepRuns.workflowRunId, seed.runId), eq(workflowStepRuns.stepId, "produce"),
        ));
      }
      if (kind === "later-pass") {
        await seedLaterQaPass(db, seed);
      }
      const [row] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, createdRow.id));
      const advice = (await loadQaRecoveryAdviceFacts(db, [row!])).get(row!.id)!;
      expect(advice).toMatchObject({ disposition: "unproven" });
      const [loaded] = await loadOperatorDecisionProjections(db, [row!]);
      expect(loaded!.view.title).toContain("unverified");
      expect(loaded!.view.description).not.toContain("source_data*");
      expect(loaded!.view.definition.options.every((option) => !option.recommended && !option.recommendationReason)).toBe(true);
      const before = await effects(seed.companyId);
      const denied = await operatorDecisionWriteService(db).resolve(row!.id, {
        actionId: "submit", selectedOptionIds: ["rerun_source_collection"], comment: `stale ${kind}`,
      }, "human").then(() => null, (error: unknown) => error);
      expect(denied).toMatchObject({ status: 409, details: {
        code: "qa_recovery_collection_choice_unproven", operatorDecisionId: row!.id,
      } });
      expect(await effects(seed.companyId)).toEqual(before);
    },
  );
});
