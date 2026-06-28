import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  evaluatorAnchorCases,
  issues,
  missions,
  missionQualityVerdicts,
  qualityEvidenceRefs,
  qualityReviewItems,
  type Db,
} from "@paperclipai/db";
import { errorHandler } from "../middleware/index.js";
import { qualityRoutes } from "../routes/quality.js";
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
});
