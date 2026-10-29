import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agentWakeupRequests, companies, createDb, operatorDecisionContinuations, operatorDecisions,
} from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { eq } from "drizzle-orm";
import { operatorDecisionWriteService } from "../services/operator-decisions-write.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { buildCardCreateInput, ensureQaSourceDefectOwnerCard } from "../services/workflow/qa-source-defect-owner-card.js";
import {
  buildHistoricalV3Candidates, buildHistoricalV3RequestKey,
  type HistoricalQaSourceDefectCardIdentityInput,
} from "../services/workflow/qa-source-defect-card-historical-v3.js";
import { seedQaSourceDefectScenario } from "./helpers/qa-source-defect-seed.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

type FrozenInput = HistoricalQaSourceDefectCardIdentityInput & { language: "en" | "ko" };
type FrozenFixture = { kind: string; input: FrozenInput; payload: CreateOperatorDecisionInput };
const fixtures = JSON.parse(readFileSync(new URL("./fixtures/qa-card-history/payloads.json", import.meta.url), "utf8")) as FrozenFixture[];
const fixture = (kind: string) => fixtures.find((row) => row.kind === kind)!;
const source = fixture("iteration0");
const mixedRecurringFindings = [
  { id: "a", summary: "Output missing", layer: "artifact" as const },
  { id: "s", summary: "Source data missing", layer: "source_data" as const },
];
// Fixed hashes from the baseline 208ceb36 v3 builder with only the artifact finding promoted.
const mixedRecurringHashes = {
  en: "be81ca67cb8223411b959f4c2896cf71c3b62c171fa15bbb15626d91b68703ef",
  ko: "30bb85a2777196e8541fcfe831ba520acdbad6a5fe4badab4dc66fb7b40bfc57",
};
const system = { type: "user", id: "system" } as const;
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
if (!support.supported) console.warn(`Skip v3 continuity regressions: ${support.reason}`);

function inputFor(kind: string): HistoricalQaSourceDefectCardIdentityInput {
  return structuredClone(fixture(kind).input) as HistoricalQaSourceDefectCardIdentityInput;
}

function candidateFor(
  input: HistoricalQaSourceDefectCardIdentityInput,
  language: "en" | "ko",
  recurringFindingIds: readonly string[] = [],
  promoted = false,
) {
  return buildHistoricalV3Candidates(input, recurringFindingIds).find((candidate) =>
    (language === "ko" ? candidate.title.startsWith("품질검수") : candidate.title.startsWith("Quality review"))
    && (!promoted || String(candidate.definition.humanReview?.evidence[0]?.description).includes("source_data*")));
}

describeDb("QA source defect v3 history continuity with real shared writer", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("qa-source-defect-v3-continuity-");
    db = createDb(tempDb.connectionString);
  }, 60_000);
  afterEach(() => vi.restoreAllMocks());
  afterAll(async () => { await db?.$client.end({ timeout: 5 }); await tempDb?.cleanup(); });

  async function company(language: "en" | "ko" = "en") {
    const id = randomUUID();
    await db.insert(companies).values({
      id, name: "QA history", issuePrefix: `Q${id.slice(0, 6)}`, defaultLanguage: language,
      requireBoardApprovalForNewAgents: false,
    });
    return id;
  }

  const rows = (companyId: string) => db.select().from(operatorDecisions).where(eq(operatorDecisions.companyId, companyId));
  const audits = (companyId: string) => db.select().from(activityLog).where(eq(activityLog.companyId, companyId));
  const continuations = (companyId: string) => db.select().from(operatorDecisionContinuations)
    .where(eq(operatorDecisionContinuations.companyId, companyId));
  const wakes = (companyId: string) => db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));

  async function seedV3(companyId: string, payload: CreateOperatorDecisionInput) {
    return (await operatorDecisionWriteService(db).create(companyId, payload, system)).decision;
  }

  it.each(["pending", "resolved", "cancelled"] as const)("replays frozen English v3 source decision unchanged when %s", async (status) => {
    const companyId = await company("en");
    const payload = { ...structuredClone(source.payload),
      requestKey: "qa-source-defect:v3:11111111-1111-4111-8111-111111111111:produce:0" };
    const seeded = await seedV3(companyId, payload);
    const original = (await rows(companyId)).find((row) => row.id === seeded.id)!;
    expect(original.requestHash).toBe("39dcc66c52b0d920d19c14d1f6a30c693f399cdb4d58696fc8677d730431966b");
    const write = operatorDecisionWriteService(db);
    if (status === "resolved") await write.resolve(original.id,
      { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: "keep result" }, "human");
    if (status === "cancelled") await write.cancel(original.id, { type: "user", id: "human" }, "human_cancelled");
    const before = { rows: await rows(companyId), audits: await audits(companyId), continuations: await continuations(companyId) };
    const input = { db, companyId, ...inputFor("iteration0") };
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await ensureQaSourceDefectOwnerCard(input)).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await rows(companyId)).toEqual(before.rows);
    expect(await audits(companyId)).toEqual(before.audits);
    expect(await continuations(companyId)).toEqual(before.continuations);
    expect((await rows(companyId)).some((row) => row.requestKey.includes(":v4:") || row.requestKey.includes("-sha256:v4:"))).toBe(false);
  });

  it.each([
    {
      name: "Korean short key", language: "ko" as const, input: inputFor("iteration0"), recurring: [],
      requestKey: "qa-source-defect:v3:11111111-1111-4111-8111-111111111111:produce:0",
      hash: "ec6d547b58deb7d8e45f1ad8f818acd5e16ffcf11ce01d64df084b6129ee2099",
    },
    {
      name: "English overflow key", language: "en" as const,
      input: { ...inputFor("iteration0"), workflowRunId: "run", producerStepId: "p".repeat(140) }, recurring: [],
      requestKey: "qa-source-defect-sha256:v3:run:803523a58a07dcb13ad3e8f0ea11de302db139f5bd859f462c5857a00863c775:0",
      hash: "ecd394f058c361c5898b298981d6398dae712c1a560d572ef2cffc1b90bdcaf3",
    },
    {
      name: "Korean digest-token producer", language: "ko" as const,
      input: { ...inputFor("iteration0"), workflowRunId: "run", producerStepId: `sha256:${"a".repeat(64)}` }, recurring: [],
      requestKey: `qa-source-defect:v3:run:sha256:${"a".repeat(64)}:0`,
      hash: "dc94d91b366e4882ec7dd7b96fa67185bc457bb5b8990cdf9fa659426b3e49bc",
    },
    {
      name: "English mixed declared findings", language: "en" as const,
      input: { ...inputFor("iteration0"), findings: [...inputFor("iteration0").findings,
        { id: "a", summary: "Output missing", layer: "artifact" as const }] }, recurring: [],
      requestKey: "qa-source-defect:v3:11111111-1111-4111-8111-111111111111:produce:0",
      hash: "785a16ddd2dfb255ff472b59a9f6371eeb1ae0c01fc389cd41b11328b7e8a53d",
    },
  ])("replays independently pinned $name identity", async ({ language, input, recurring, requestKey, hash }) => {
    const originalInput = structuredClone(input);
    const candidate = candidateFor(input, language, recurring)!;
    expect(buildHistoricalV3RequestKey(input)).toBe(requestKey);
    expect(candidate.requestKey).toBe(requestKey);
    expect(validateAndHashOperatorDecisionCreate(candidate).requestHash).toBe(hash);
    const companyId = await company(language);
    const original = await seedV3(companyId, candidate);
    const before = await rows(companyId);
    const ensureInput = { db, companyId, ...originalInput };
    expect(await ensureQaSourceDefectOwnerCard(ensureInput)).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await ensureQaSourceDefectOwnerCard(ensureInput)).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await rows(companyId)).toEqual(before);
  });

  it("pins recurrence-promoted artifact identity while retaining the declared current cause", () => {
    const input = { ...inputFor("iteration0"), findings: [{ id: "f", summary: "Source data missing", layer: "artifact" as const }] };
    const candidate = candidateFor(input, "en", ["f"], true)!;
    expect(input.findings[0]!.layer).toBe("artifact");
    expect(candidate.requestKey).toBe("qa-source-defect:v3:11111111-1111-4111-8111-111111111111:produce:0");
    expect(validateAndHashOperatorDecisionCreate(candidate).requestHash).toBe("0842a9dbb89c8265e28f741ee641599ba032e776880a022e430e338de3037729");
  });

  it.each(["en", "ko"] as const)("replays pinned baseline-208 mixed recurrence v3 payload in %s unchanged in every state", async (language) => {
    const recurring = mixedRecurringFindings.map(({ id }) => id);
    const fixedInput = { ...inputFor("iteration0"), findings: mixedRecurringFindings };
    const pinned = candidateFor(fixedInput, language, recurring, true)!;
    expect(validateAndHashOperatorDecisionCreate(pinned).requestHash).toBe(mixedRecurringHashes[language]);
    expect(pinned.definition.options[0]!.facts[0]!.value).toContain(language === "en" ? "1 recurring finding" : "재발 1건");
    const evidence = pinned.definition.humanReview!.evidence[0]!.description;
    expect(evidence.match(/\[source_data\*\]/gu) ?? []).toHaveLength(1);
    expect(evidence).toContain("[source_data*] (a) Output missing");
    expect(evidence).toContain("[source_data] (s) Source data missing");

    for (const status of ["pending", "resolved", "cancelled"] as const) {
      const seed = await seedQaSourceDefectScenario(db, mixedRecurringFindings, { priorFindings: mixedRecurringFindings });
      await db.update(companies).set({ defaultLanguage: language }).where(eq(companies.id, seed.companyId));
      const input = { companyId: seed.companyId, missionId: seed.missionId, workflowRunId: seed.runId,
        producerStepId: "produce", iteration: 0, maxIterations: 2, findings: mixedRecurringFindings,
        qaRefs: [{ qaStepId: "qa-validate", qaIssueId: seed.qaIssueId }], linkIssueId: seed.oversightIssueId };
      const original = await seedV3(seed.companyId, candidateFor(input, language, recurring, true)!);
      const write = operatorDecisionWriteService(db);
      if (status === "resolved") await write.resolve(original.id,
        { actionId: "submit", selectedOptionIds: ["maintenance_issue"], comment: "keep result" }, "human");
      if (status === "cancelled") await write.cancel(original.id, { type: "user", id: "human" }, "human_cancelled");
      const before = { rows: await rows(seed.companyId), audits: await audits(seed.companyId),
        continuations: await continuations(seed.companyId), wakes: await wakes(seed.companyId) };
      const ensureInput = { db, ...input };
      expect(await ensureQaSourceDefectOwnerCard(ensureInput)).toEqual({ outcome: "replayed", decisionId: original.id });
      expect(await ensureQaSourceDefectOwnerCard(ensureInput)).toEqual({ outcome: "replayed", decisionId: original.id });
      expect(await rows(seed.companyId)).toEqual(before.rows);
      expect(await audits(seed.companyId)).toEqual(before.audits);
      expect(await continuations(seed.companyId)).toEqual(before.continuations);
      expect(await wakes(seed.companyId)).toEqual(before.wakes);
    }
  });

  it("replays a promoted artifact decision from official prior findings without creating a v4 decision", async () => {
    const finding = { id: "mobile-overflow", summary: "table overflows on mobile", layer: "artifact" as const };
    const scenario = await seedQaSourceDefectScenario(db, [finding], { priorFindings: [finding] });
    const input = {
      companyId: scenario.companyId, missionId: scenario.missionId, workflowRunId: scenario.runId,
      producerStepId: "produce", iteration: 0, maxIterations: 2, findings: [finding],
      qaRefs: [{ qaStepId: "qa-validate", qaIssueId: scenario.qaIssueId }], linkIssueId: scenario.oversightIssueId,
    };
    const candidate = candidateFor(input, "en", [finding.id], true)!;
    const original = await seedV3(scenario.companyId, candidate);
    const before = { rows: await rows(scenario.companyId), audits: await audits(scenario.companyId),
      continuations: await continuations(scenario.companyId) };
    expect(await ensureQaSourceDefectOwnerCard({ db, ...input })).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await ensureQaSourceDefectOwnerCard({ db, ...input })).toEqual({ outcome: "replayed", decisionId: original.id });
    expect(await rows(scenario.companyId)).toEqual(before.rows);
    expect(await audits(scenario.companyId)).toEqual(before.audits);
    expect(await continuations(scenario.companyId)).toEqual(before.continuations);
    expect((await rows(scenario.companyId)).some((row) => row.requestKey.includes(":v4:") || row.requestKey.includes("-sha256:v4:"))).toBe(false);
  });

  it("fails closed without cleanup when an exact v3 and current v4 row already coexist", async () => {
    const companyId = await company();
    const input = inputFor("iteration0");
    await seedV3(companyId, candidateFor(input, "en")!);
    await seedV3(companyId, buildCardCreateInput({ ...input, language: "en" }));
    const before = { rows: await rows(companyId), audits: await audits(companyId) };
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId, ...input })).outcome).toBe("conflict");
    expect(await rows(companyId)).toEqual(before.rows);
    expect(await audits(companyId)).toEqual(before.audits);
  });

  it("holds unknown hashes and changed domain inputs before prior-generation cleanup", async () => {
    const changes = [
      { maxIterations: 3 },
      { findings: [{ id: "f", summary: "Changed", layer: "source_data" as const }] },
      { qaRefs: [{ qaStepId: "different", qaIssueId: null }] },
      { missionId: randomUUID() },
      { linkIssueId: randomUUID() },
    ];
    for (const change of changes) {
      const companyId = await company();
      const targetInput = inputFor("iteration1");
      const seededTarget = await seedV3(companyId, candidateFor(targetInput, "en")!);
      const target = (await rows(companyId)).find((row) => row.id === seededTarget.id)!;
      const stale = await seedV3(companyId, candidateFor(inputFor("iteration0"), "en")!);
      const before = { rows: await rows(companyId), audits: await audits(companyId) };
      expect((await ensureQaSourceDefectOwnerCard({ db, companyId, ...targetInput, ...change })).outcome).toBe("conflict");
      expect(await rows(companyId)).toEqual(before.rows);
      expect(await audits(companyId)).toEqual(before.audits);
      expect((await rows(companyId)).find((row) => row.id === target.id)?.requestHash).toBe(target.requestHash);
      expect((await rows(companyId)).find((row) => row.id === stale.id)?.status).toBe("pending");
    }

    const bindingCompany = await company();
    const bindingInput = inputFor("iteration1");
    const seededBindingTarget = await seedV3(bindingCompany, candidateFor(bindingInput, "en")!);
    const bindingTarget = (await rows(bindingCompany)).find((row) => row.id === seededBindingTarget.id)!;
    const bindingStale = await seedV3(bindingCompany, candidateFor(inputFor("iteration0"), "en")!);
    await db.update(operatorDecisions).set({ sourceId: `${bindingTarget.sourceId}:changed` })
      .where(eq(operatorDecisions.id, bindingTarget.id));
    const bindingBefore = { rows: await rows(bindingCompany), audits: await audits(bindingCompany) };
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId: bindingCompany, ...bindingInput })).outcome).toBe("conflict");
    expect(await rows(bindingCompany)).toEqual(bindingBefore.rows);
    expect(await audits(bindingCompany)).toEqual(bindingBefore.audits);
    expect((await rows(bindingCompany)).find((row) => row.id === bindingStale.id)?.status).toBe("pending");

    const companyId = await company();
    const targetInput = inputFor("iteration1");
    const seededUnknownTarget = await seedV3(companyId, candidateFor(targetInput, "en")!);
    const target = (await rows(companyId)).find((row) => row.id === seededUnknownTarget.id)!;
    const stale = await seedV3(companyId, candidateFor(inputFor("iteration0"), "en")!);
    await db.update(operatorDecisions).set({ requestHash: "unknown-v3-hash" }).where(eq(operatorDecisions.id, target.id));
    const before = { rows: await rows(companyId), audits: await audits(companyId) };
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId, ...targetInput })).outcome).toBe("conflict");
    expect(await rows(companyId)).toEqual(before.rows);
    expect(await audits(companyId)).toEqual(before.audits);
    expect((await rows(companyId)).find((row) => row.id === stale.id)?.status).toBe("pending");
  });

  it("keeps v3 lookup company and producer scoped, and lets a validated next generation supersede", async () => {
    const ownerCompany = await company();
    const otherCompany = await company();
    const original = await seedV3(ownerCompany, candidateFor(inputFor("iteration0"), "en")!);
    const sameInput = inputFor("iteration0");
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId: otherCompany, ...sameInput })).outcome).toBe("created");
    const other = await rows(otherCompany);
    expect(other).toHaveLength(1);
    expect(other[0]!.requestKey).toContain(":v4:");

    const differentProducer = { ...sameInput, producerStepId: "other-producer" };
    expect((await ensureQaSourceDefectOwnerCard({ db, companyId: ownerCompany, ...differentProducer })).outcome).toBe("created");
    expect((await rows(ownerCompany)).find((row) => row.id === original.id)?.status).toBe("pending");

    const nextInput = inputFor("iteration1");
    const next = await ensureQaSourceDefectOwnerCard({ db, companyId: ownerCompany, ...nextInput });
    expect(next.outcome).toBe("created");
    const finalRows = await rows(ownerCompany);
    expect(finalRows.find((row) => row.id === original.id)?.status).toBe("cancelled");
    expect(finalRows.find((row) => row.requestKey.includes(":v4:") && row.sourceId?.endsWith(":1"))?.status).toBe("pending");
  });
});
