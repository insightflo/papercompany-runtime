import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { strategyPlaybookRoutes } from "../routes/strategy-playbook.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping strategy playbook route tests: ${support.reason ?? "unsupported"}`);
}

function boardActor(companyIds: string[]) {
  return { type: "board", userId: "board-1", companyIds, source: "session", isInstanceAdmin: false };
}

const validProposal = {
  channel: "knowledge",
  triggerType: "topic_surge",
  conditionJson: { window: "1h", threshold: 3 },
  actionType: "boost_schedule",
  actionJson: { slots: 2 },
  evidenceRefs: ["issue://42"],
};

describeEP("strategy playbook routes (embedded DB)", () => {
  function createApp(actor: Record<string, unknown>) {
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => {
      (req as any).actor = actor;
      next();
    });
    app.use("/api", strategyPlaybookRoutes(db as any));
    app.use(errorHandler);
    return app;
  }

  function agentActor(cid = companyId, aid = "agent-1") {
    return { type: "agent", agentId: aid, companyId: cid, source: "agent_key" };
  }

  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let otherCompanyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("strategy-playbook-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    otherCompanyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values([
      { id: companyId, name: "Playbook Co", status: "active", issuePrefix: "PBC1" },
      { id: otherCompanyId, name: "Other Co", status: "active", issuePrefix: "PBC2" },
    ]);
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Playbook Agent",
      role: "researcher",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
  }, 60_000);

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  it("forces status=proposed on creation and records the agent proposer", async () => {
    const app = createApp(agentActor(companyId, agentId));
    const res = await request(app)
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.status).toBe("proposed");
    expect(res.body.proposedByAgentId).toBe(agentId);
    expect(res.body.activatedAt).toBeNull();
    expect(res.body.channel).toBe("knowledge");
  });

  it("rejects requests that try to set status directly (strict schema, 422)", async () => {
    const app = createApp(boardActor([companyId]));
    const res = await request(app)
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send({ ...validProposal, status: "active" });
    expect(res.status).toBe(422);
  });

  it("rejects non-object conditionJson/actionJson and bad channel", async () => {
    const app = createApp(boardActor([companyId]));
    const badCondition = await request(app)
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send({ ...validProposal, conditionJson: "not-an-object" });
    expect(badCondition.status).toBe(422);

    const badChannel = await request(app)
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send({ ...validProposal, channel: "finance" });
    expect(badChannel.status).toBe(422);
  });

  it("blocks cross-company access on list, create, and patch", async () => {
    // 시딩: companyId 소유 제안 1건
    const seeded = await request(createApp(boardActor([companyId])))
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(seeded.status).toBe(201);
    const entryId = seeded.body.id;

    const agentOutsider = createApp(agentActor(otherCompanyId));
    const listRes = await request(agentOutsider).get(`/api/companies/${companyId}/strategy-playbook`);
    expect(listRes.status).toBe(403);

    const createRes = await request(agentOutsider)
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(createRes.status).toBe(403);

    // 다른 회사 board 사용자도 타 회사 항목 전이 불가
    const boardOutsider = createApp(boardActor([otherCompanyId]));
    const patchRes = await request(boardOutsider)
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "active" });
    expect(patchRes.status).toBe(403);
  });

  it("lists entries scoped to the company", async () => {
    const seededOther = await request(createApp(boardActor([otherCompanyId])))
      .post(`/api/companies/${otherCompanyId}/strategy-playbook`)
      .send({ ...validProposal, channel: "shopping" });
    expect(seededOther.status).toBe(201);

    const res = await request(createApp(boardActor([companyId])))
      .get(`/api/companies/${companyId}/strategy-playbook`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(res.body.entries.every((e: { companyId: string }) => e.companyId === companyId)).toBe(true);

    const filtered = await request(createApp(boardActor([companyId])))
      .get(`/api/companies/${companyId}/strategy-playbook?status=proposed`);
    expect(filtered.status).toBe(200);
    expect(filtered.body.entries.every((e: { status: string }) => e.status === "proposed")).toBe(true);
  });

  it("rejects agent activation attempts with 403 and leaves status untouched", async () => {
    const seeded = await request(createApp(agentActor(companyId, agentId)))
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(seeded.status).toBe(201);

    const res = await request(createApp(agentActor(companyId, agentId)))
      .patch(`/api/strategy-playbook/${seeded.body.id}`)
      .send({ status: "active" });
    expect(res.status).toBe(403);

    const after = await request(createApp(boardActor([companyId])))
      .get(`/api/companies/${companyId}/strategy-playbook?status=proposed`);
    const still = after.body.entries.find((e: { id: string }) => e.id === seeded.body.id);
    expect(still).toBeDefined();
    expect(still.status).toBe("proposed");
  });

  it("board activation succeeds and stamps activatedAt; retirement stamps retiredAt", async () => {
    const seeded = await request(createApp(boardActor([companyId])))
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(seeded.status).toBe(201);

    const activated = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${seeded.body.id}`)
      .send({ status: "active" });
    expect(activated.status, JSON.stringify(activated.body)).toBe(200);
    expect(activated.body.status).toBe("active");
    expect(activated.body.activatedAt).toBeTruthy();
    expect(activated.body.retiredAt).toBeNull();

    const retired = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${activated.body.id}`)
      .send({ status: "retired" });
    expect(retired.status, JSON.stringify(retired.body)).toBe(200);
    expect(retired.body.status).toBe("retired");
    expect(retired.body.retiredAt).toBeTruthy();
  });

  it("rejects invalid transitions: proposed→retired, re-activation, and same-status", async () => {
    const seeded = await request(createApp(boardActor([companyId])))
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(seeded.status).toBe(201);
    const entryId = seeded.body.id;

    // proposed → retired 는 허용 전이가 아니다 (은퇴는 active 에서만)
    const earlyRetire = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "retired" });
    expect(earlyRetire.status).toBe(409);

    const activated = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "active" });
    expect(activated.status).toBe(200);

    // active → proposed (되돌리기) 거부
    const rollback = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "proposed" });
    expect(rollback.status).toBe(409);

    const retired = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "retired" });
    expect(retired.status).toBe(200);

    // retired → active 재활성 거부
    const reActivate = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "active" });
    expect(reActivate.status).toBe(409);

    // retired → retired 동일 상태 재설정 거부
    const reRetire = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${entryId}`)
      .send({ status: "retired" });
    expect(reRetire.status).toBe(409);
  });

  it("returns 404 for unknown entry ids", async () => {
    const res = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${randomUUID()}`)
      .send({ status: "active" });
    expect(res.status).toBe(404);
  });

  it("rejects patch bodies that change anything other than status", async () => {
    const seeded = await request(createApp(boardActor([companyId])))
      .post(`/api/companies/${companyId}/strategy-playbook`)
      .send(validProposal);
    expect(seeded.status).toBe(201);

    const res = await request(createApp(boardActor([companyId])))
      .patch(`/api/strategy-playbook/${seeded.body.id}`)
      .send({ status: "active", actionType: "override" });
    expect(res.status).toBe(422);
  });
});
