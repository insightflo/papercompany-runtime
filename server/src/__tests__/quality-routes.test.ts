import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  evaluatorAnchorCases,
  evaluatorCandidateRuns,
  evaluatorVersions,
  issues,
  missions,
  missionQualityVerdicts,
  qualityDailyReports,
  qualityEvidenceRefs,
  qualityReviewItems,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { qualityRoutes } from "../routes/quality.js";
import { qualityService } from "../services/quality.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping embedded Postgres quality route tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

type Actor = { type: "board"; source: "session"; userId: string; companyIds: string[]; isInstanceAdmin?: boolean };

function createApp(db: Db, actor: Actor) {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.actor = actor as typeof req.actor;
    next();
  });
  app.use("/api", qualityRoutes(db));
  app.use(errorHandler);
  return app;
}

function prefix(id: string, marker: string) {
  return `${marker}${id.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
}

describeEmbeddedPostgres("quality routes", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-quality-routes-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(qualityDailyReports);
    await db.delete(evaluatorCandidateRuns);
    await db.delete(evaluatorVersions);
    await db.delete(evaluatorAnchorCases);
    await db.delete(missionQualityVerdicts);
    await db.delete(qualityEvidenceRefs);
    await db.delete(qualityReviewItems);
    await db.delete(issues);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(marker: string) {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: `${marker} Company`,
      issuePrefix: prefix(companyId, marker),
      requireBoardApprovalForNewAgents: false,
    });
    return companyId;
  }

  async function seedMission(companyId: string, status = "active") {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "ceo",
      adapterType: "process",
    });
    const missionId = randomUUID();
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mission with quality follow-up",
      status,
    });
    return missionId;
  }

  it("lists only quality review items for the requested company", async () => {
    const companyA = await seedCompany("QA");
    const companyB = await seedCompany("QB");
    const itemA = randomUUID();
    const itemB = randomUUID();

    await db.insert(qualityReviewItems).values([
      {
        id: itemA,
        companyId: companyA,
        title: "A public URL needs review",
        status: "awaiting_review",
        targetType: "public_url",
        triggerSource: "delivery_verification",
        triggerMetadata: { url: "https://example.test/a" },
        priority: "high",
      },
      {
        id: itemB,
        companyId: companyB,
        title: "B content needs review",
        status: "awaiting_review",
        targetType: "work_product",
        triggerSource: "manual",
        triggerMetadata: {},
        priority: "medium",
      },
    ]);
    await db.insert(qualityEvidenceRefs).values({
      companyId: companyA,
      reviewItemId: itemA,
      surface: "public_url",
      expected: { status: 200 },
      actual: { status: 404 },
      status: "failed",
      blocking: true,
    });

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "reviewer-a",
      companyIds: [companyA],
    })).get(`/api/companies/${companyA}/quality/review-items`);

    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect(res.body[0]).toMatchObject({
      id: itemA,
      companyId: companyA,
      evidenceRefs: [expect.objectContaining({ surface: "public_url", status: "failed" })],
    });
  });

  it("blocks board users from reading another company's quality board", async () => {
    const companyA = await seedCompany("QC");
    const companyB = await seedCompany("QD");

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "reviewer-b",
      companyIds: [companyB],
    })).get(`/api/companies/${companyA}/quality/review-items`);

    expect(res.status).toBe(403);
  });

  it("records a needs_evidence verdict and creates a company-scoped follow-up issue", async () => {
    const companyId = await seedCompany("QE");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      title: "Published page needs browser readback",
      status: "awaiting_review",
      targetType: "public_url",
      triggerSource: "post_completion_audit",
      triggerMetadata: { url: "https://manual-onboarding.pages.dev/onboarding/example/" },
      priority: "critical",
    });

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "human-reviewer",
      companyIds: [companyId],
    }))
      .post(`/api/quality/review-items/${reviewItemId}/verdict`)
      .send({
        verdict: "needs_evidence",
        reason: "Final public URL was not checked in browser.",
        requiredEvidenceSurfaces: ["browser_readback"],
      });

    expect(res.status).toBe(201);
    expect(res.body.verdict).toMatchObject({
      companyId,
      verdict: "needs_evidence",
      decidedByUserId: "human-reviewer",
    });
    expect(res.body.reviewItem).toMatchObject({
      id: reviewItemId,
      companyId,
      status: "evidence_collecting",
    });

    const [followUp] = await db.select().from(issues);
    expect(followUp).toMatchObject({
      companyId,
      status: "todo",
      originKind: "quality_evidence_request",
      originId: reviewItemId,
    });
  });

  it("creates a company-scoped evidence issue when the source mission is already completed", async () => {
    const companyId = await seedCompany("QG");
    const missionId = await seedMission(companyId, "completed");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      missionId,
      title: "Completed mission public URL still needs readback",
      status: "awaiting_review",
      targetType: "public_url",
      triggerSource: "post_completion_audit",
      triggerMetadata: { url: "https://manual-onboarding.pages.dev/onboarding/example/" },
      priority: "high",
    });

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "human-reviewer",
      companyIds: [companyId],
    }))
      .post(`/api/quality/review-items/${reviewItemId}/verdict`)
      .send({
        verdict: "needs_evidence",
        reason: "Published URL must be checked even after mission completion.",
        requiredEvidenceSurfaces: ["browser_readback"],
      });

    expect(res.status).toBe(201);
    const [followUp] = await db.select().from(issues);
    expect(followUp).toMatchObject({
      companyId,
      missionId: null,
      status: "todo",
      originKind: "quality_evidence_request",
      originId: reviewItemId,
    });
    expect(followUp.description).toContain(missionId);
  });

  it("promotes a human verdict to a company-scoped anchor case", async () => {
    const companyId = await seedCompany("QF");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      title: "Feynman page missed the core method",
      status: "awaiting_review",
      targetType: "work_product",
      triggerSource: "user_feedback",
      triggerMetadata: {},
      failureType: "content_missing_core_concept",
      priority: "high",
    });
    const [verdict] = await db.insert(missionQualityVerdicts).values({
      companyId,
      reviewItemId,
      targetType: "work_product",
      verdict: "fail",
      failureType: "content_missing_core_concept",
      reason: "The output did not explain the actual Feynman technique.",
      decidedByUserId: "human-reviewer",
    }).returning();

    const res = await request(createApp(db, {
      type: "board",
      source: "session",
      userId: "human-reviewer",
      companyIds: [companyId],
    }))
      .post(`/api/quality/review-items/${reviewItemId}/promote-anchor`)
      .send({ verdictId: verdict.id, title: "Feynman content false pass" });

    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      companyId,
      reviewItemId,
      sourceVerdictId: verdict.id,
      status: "candidate",
      failureType: "content_missing_core_concept",
    });
  });

  it("creates a review item via the manual endpoint and dedupes an identical open one", async () => {
    const companyId = await seedCompany("QH");
    const actor = { type: "board" as const, source: "session" as const, userId: "reviewer-h", companyIds: [companyId] };
    const app = createApp(db, actor);

    const first = await request(app).post(`/api/companies/${companyId}/quality/review-items`).send({
      title: "Public page 404",
      targetType: "public_url",
      triggerSource: "delivery_verification",
      targetId: "https://example.test/h",
      failureType: "delivery_url_404",
    });
    expect(first.status).toBe(201);
    expect(first.body.created).toBe(true);
    const firstId = first.body.reviewItem.id;

    const second = await request(app).post(`/api/companies/${companyId}/quality/review-items`).send({
      title: "Public page 404 (dup)",
      targetType: "public_url",
      triggerSource: "delivery_verification",
      targetId: "https://example.test/h",
    });
    expect(second.status).toBe(201);
    expect(second.body.created).toBe(false);
    expect(second.body.reviewItem.id).toBe(firstId);
  });

  it("records collected evidence and reopens the review item once all surfaces resolve", async () => {
    const companyId = await seedCompany("QI");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      title: "Evidence collecting item",
      status: "evidence_collecting",
      targetType: "public_url",
      triggerSource: "delivery_verification",
      triggerMetadata: {},
      priority: "high",
    });
    await db.insert(qualityEvidenceRefs).values({
      companyId,
      reviewItemId,
      surface: "browser_readback",
      status: "missing",
      blocking: true,
    });
    const actor = { type: "board" as const, source: "session" as const, userId: "reviewer-i", companyIds: [companyId] };

    const res = await request(createApp(db, actor))
      .post(`/api/quality/review-items/${reviewItemId}/evidence`)
      .send({ surface: "browser_readback", status: "verified", sourceUrl: "https://example.test/i" });

    expect(res.status).toBe(201);
    expect(res.body.reviewItem).toMatchObject({ id: reviewItemId, status: "awaiting_review" });
    expect(res.body.reviewItem.evidenceRefs[0]).toMatchObject({ surface: "browser_readback", status: "verified" });
  });

  it("creates a correction issue on a fail verdict", async () => {
    const companyId = await seedCompany("QJ");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      title: "Misleading summary",
      status: "awaiting_review",
      targetType: "work_product",
      triggerSource: "user_feedback",
      triggerMetadata: {},
      failureType: "content_missing_core_concept",
      priority: "high",
    });

    const res = await request(createApp(db, {
      type: "board", source: "session", userId: "reviewer-j", companyIds: [companyId],
    }))
      .post(`/api/quality/review-items/${reviewItemId}/verdict`)
      .send({ verdict: "fail", reason: "Core concept missing." });

    expect(res.status).toBe(201);
    expect(res.body.reviewItem.status).toBe("anchor_candidate");
    const correction = (await db.select().from(issues)).find((i) => i.originKind === "quality_correction_request");
    expect(correction).toMatchObject({ companyId, status: "todo", originId: reviewItemId });
  });

  it("seeds an evaluator candidate + replay run on promote-anchor and gates production promotion on a passed replay", async () => {
    const companyId = await seedCompany("QK");
    const reviewItemId = randomUUID();
    await db.insert(qualityReviewItems).values({
      id: reviewItemId,
      companyId,
      title: "Anchor seed target",
      status: "anchor_candidate",
      targetType: "work_product",
      triggerSource: "user_feedback",
      triggerMetadata: {},
      failureType: "qa_false_pass",
      priority: "high",
    });
    const [verdict] = await db.insert(missionQualityVerdicts).values({
      companyId,
      reviewItemId,
      targetType: "work_product",
      verdict: "fail",
      failureType: "qa_false_pass",
      decidedByUserId: "reviewer-k",
    }).returning();
    const actor = { type: "board" as const, source: "session" as const, userId: "reviewer-k", companyIds: [companyId] };
    const app = createApp(db, actor);

    const promote = await request(app).post(`/api/quality/review-items/${reviewItemId}/promote-anchor`).send({ verdictId: verdict.id, title: "QA false pass anchor" });
    expect(promote.status).toBe(201);

    const [version] = await db.select().from(evaluatorVersions);
    expect(version.status).toBe("candidate");
    const [run] = await db.select().from(evaluatorCandidateRuns);
    expect(run.status).toBe("queued");

    // Production promotion must fail before a replay passes.
    const blocked = await request(app).post(`/api/companies/${companyId}/quality/evaluator-versions/${version.id}/promote`).send({});
    expect(blocked.status).toBe(422);

    // Run the replay (deterministic pass), then promotion succeeds.
    const replay = await request(app).post(`/api/companies/${companyId}/quality/candidate-runs/${run.id}/replay`).send({});
    expect(replay.status).toBe(200);
    expect(replay.body.status).toBe("passed");

    const promoted = await request(app).post(`/api/companies/${companyId}/quality/evaluator-versions/${version.id}/promote`).send({});
    expect(promoted.status).toBe(200);
    expect(promoted.body.status).toBe("production");
  });

  it("generates a daily quality report with failure-type and evidence-gap summary", async () => {
    const companyId = await seedCompany("QL");
    await db.insert(qualityReviewItems).values([
      { id: randomUUID(), companyId, title: "a", status: "awaiting_review", targetType: "public_url", triggerSource: "delivery_verification", triggerMetadata: {}, priority: "high", failureType: "delivery_url_404" },
      { id: randomUUID(), companyId, title: "b", status: "evidence_collecting", targetType: "work_product", triggerSource: "manual", triggerMetadata: {}, priority: "medium", failureType: "evidence_incomplete" },
    ]);
    const res = await request(createApp(db, {
      type: "board", source: "session", userId: "reviewer-l", companyIds: [companyId],
    })).post(`/api/companies/${companyId}/quality/daily-reports/generate`).send({});

    expect(res.status).toBe(201);
    expect(res.body.report.summary.failureTypeCounts).toMatchObject({ delivery_url_404: 1, evidence_incomplete: 1 });
    expect(res.body.report.summary.pendingReviewItems).toBe(1);
    expect(res.body.report.summary.needsEvidenceOutstanding).toBe(1);
  });

  it("returns a company-scoped quality summary and blocks cross-company access", async () => {
    const companyA = await seedCompany("QM");
    const companyB = await seedCompany("QN");
    await db.insert(qualityReviewItems).values({
      id: randomUUID(), companyId: companyA, title: "s", status: "awaiting_review", targetType: "work_product", triggerSource: "manual", triggerMetadata: {}, priority: "medium",
    });

    const ok = await request(createApp(db, { type: "board", source: "session", userId: "r", companyIds: [companyA] }))
      .get(`/api/companies/${companyA}/quality/summary`);
    expect(ok.status).toBe(200);
    expect(ok.body.openReviewItems).toBe(1);

    const blocked = await request(createApp(db, { type: "board", source: "session", userId: "r", companyIds: [companyB] }))
      .get(`/api/companies/${companyA}/quality/summary`);
    expect(blocked.status).toBe(403);
  });

  it("auto-creates an oversight stall review item (plan 8.1) and dedupes per mission", async () => {
    const companyId = await seedCompany("QO");
    const missionId = await seedMission(companyId, "active");
    const svc = qualityService(db);

    const first = await svc.createOversightStallReviewItem({ companyId, missionId, missionTitle: "Oversighted mission" });
    const second = await svc.createOversightStallReviewItem({ companyId, missionId, missionTitle: "Oversighted mission" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewItem.id).toBe(first.reviewItem.id);
    expect(first.reviewItem).toMatchObject({
      companyId,
      missionId,
      targetType: "mission_output",
      triggerSource: "oversight_stall",
      status: "awaiting_review",
      failureType: "plan_submission_missing",
    });
  });

  it("auto-creates a delivery verification failure review item (plan 8.1) with missing evidence surfaces", async () => {
    const companyId = await seedCompany("QP");
    const svc = qualityService(db);

    const first = await svc.createDeliveryFailureReviewItem({ companyId, stepId: "qa-delivery-readback" });
    const second = await svc.createDeliveryFailureReviewItem({ companyId, stepId: "qa-delivery-readback" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewItem.id).toBe(first.reviewItem.id);
    expect(first.reviewItem).toMatchObject({
      companyId,
      targetType: "public_url",
      triggerSource: "delivery_verification",
      failureType: "delivery_url_404",
    });
    const surfaces = first.reviewItem.evidenceRefs.map((r) => r.surface).sort();
    expect(surfaces).toEqual(["browser_readback", "public_url"]);
    expect(first.reviewItem.evidenceRefs.every((r) => r.blocking && r.status === "missing")).toBe(true);
    // context for the collector is carried in expected + triggerMetadata.
    expect(first.reviewItem.evidenceRefs[0].expected).toMatchObject({ qaStepId: "qa-delivery-readback" });
  });

  it("auto-creates a final QA / purpose-fitness failure review item (plan 8.1) and dedupes per mission", async () => {
    const companyId = await seedCompany("QQ");
    const missionId = await seedMission(companyId, "active");
    const svc = qualityService(db);

    const first = await svc.createMissionQualityFailureReviewItem({
      companyId,
      missionId,
      missionTitle: "Purpose-fitness mission",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
      reason: "Final QA requested changes.",
    });
    const second = await svc.createMissionQualityFailureReviewItem({
      companyId,
      missionId,
      missionTitle: "Purpose-fitness mission",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.reviewItem.id).toBe(first.reviewItem.id);
    expect(first.reviewItem).toMatchObject({
      companyId,
      missionId,
      targetType: "mission_output",
      triggerSource: "final_qa_failure",
      failureType: "plan_goal_mismatch",
    });
  });
});
