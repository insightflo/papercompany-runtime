import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { companies, missionAgents, missions, projects } from "@paperclipai/db";
import { missionService } from "../services/missions.js";
import { missionReaderApp, missionReadState } from "./helpers/mission-query-readonly.js";
import { seedTerminalTransaction, startTerminalTransactionDatabase } from "./helpers/mission-terminal-transaction.js";

// Breaks caught: GET/list settling completed workflows, dropping stored-active list rows,
// writing even transiently, losing company/shape/filter contracts, or waiting on row writers.
describe("mission queries read stored state without lifecycle writes", () => {
  let testDb: Awaited<ReturnType<typeof startTerminalTransactionDatabase>>;
  beforeAll(async () => { testDb = await startTerminalTransactionDatabase(); }, 60_000);
  afterAll(async () => { await testDb?.cleanup(); });

  it.each(["service detail", "service list", "HTTP detail", "HTTP list"] as const)(
    "%s repeatedly returns stored active state and only emits SELECTs", async (surface) => {
      const { db, trace } = testDb;
      const f = await seedTerminalTransaction(db, true);
      const projectId = randomUUID();
      await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Read project", color: "#123456" });
      await db.update(missions).set({ projectId }).where(eq(missions.id, f.missionId));
      await db.insert(missionAgents).values({ missionId: f.missionId, agentId: f.mission.ownerAgentId, role: "executor" });
      const before = await missionReadState(db, f);
      expect(before.workflows[0].status).toBe("completed");
      expect(before.issues[0]).toMatchObject({ status: "in_progress", executionRunId: f.runId, checkoutRunId: f.runId });
      expect(before.runs[0].status).toBe("running");
      expect(before.runtimes[0].status).toBe("busy");
      const svc = missionService(db), app = missionReaderApp(db, f);
      await db.$client.unsafe("truncate terminal_test_writes");
      for (let repeat = 0; repeat < 3; repeat++) {
        const start = trace.length;
        let detail;
        if (surface === "service detail") detail = await svc.getById(f.missionId);
        else if (surface === "service list") {
          const rows = await svc.list({ companyId: f.companyId, status: "active" });
          expect(rows).toHaveLength(1);
          [detail] = rows;
        } else {
          const path = surface === "HTTP detail" ? `/api/missions/${f.missionId}` : `/api/companies/${f.companyId}/missions?status=active`;
          const response = await request(app).get(path);
          expect(response.status).toBe(200);
          if (surface === "HTTP list") expect(response.body).toHaveLength(1);
          detail = surface === "HTTP detail" ? response.body : response.body[0];
        }
        expect(detail).toMatchObject({ id: f.missionId, status: "active", completedAt: null, project: { id: projectId, name: "Read project", color: "#123456" } });
        if (surface.endsWith("detail")) {
          expect(detail).toMatchObject({ ownerAgentName: "Runner", sessionBindings: [], ownerActionExplanations: [] });
          expect(detail.agents).toEqual([expect.objectContaining({ agentId: f.mission.ownerAgentId, agentName: "Runner", role: "executor" })]);
          expect(detail).toHaveProperty("activeMissionPlan");
        }
        const queries = trace.slice(start).map(({ query }) => query.trim());
        expect(queries.length).toBeGreaterThan(0);
        expect(queries.filter((query) => !/^select\s/i.test(query))).toEqual([]);
        expect(await missionReadState(db, f)).toEqual(before);
        expect(await db.$client.unsafe("select * from terminal_test_writes")).toHaveLength(0);
      }
    },
  );

  it.each(["service detail", "service list", "HTTP detail", "HTTP list"] as const)(
    "%s succeeds before a separate mission/issue UPDATE transaction is released", async (surface) => {
      const { db, trace } = testDb;
      const f = await seedTerminalTransaction(db, true);
      const before = await missionReadState(db, f);
      const app = missionReaderApp(db, f), svc = missionService(db);
      const blocker = await db.$client.reserve();
      let released = false;
      try {
        await blocker.unsafe("begin");
        await blocker.unsafe("update missions set title = 'Uncommitted mission' where id = $1", [f.missionId]);
        await blocker.unsafe("update issues set title = 'Uncommitted oversight' where id = $1", [f.issueId]);
        const [held] = await blocker.unsafe("select pg_backend_pid() as pid, txid_current()::text as txid");
        const start = trace.length;
        let detail;
        if (surface === "service detail") detail = await svc.getById(f.missionId);
        else if (surface === "service list") [detail] = await svc.list({ companyId: f.companyId, status: "active" });
        else {
          const path = surface === "HTTP detail" ? `/api/missions/${f.missionId}` : `/api/companies/${f.companyId}/missions?status=active`;
          const response = await request(app).get(path).timeout(5_000);
          expect(response.status).toBe(200);
          detail = surface === "HTTP detail" ? response.body : response.body[0];
        }
        expect(detail).toMatchObject({ id: f.missionId, status: "active", title: "Terminal transaction" });
        expect(trace.slice(start).filter(({ query }) => !/^\s*select\s/i.test(query))).toEqual([]);
        // Positive ordering proof, not a latency threshold: the same transaction still
        // sees both uncommitted UPDATEs after the successful read has returned.
        expect(released).toBe(false);
        const [stillHeld] = await blocker.unsafe("select pg_backend_pid() as pid, txid_current()::text as txid");
        expect(stillHeld).toEqual(held);
        const [ownMission] = await blocker.unsafe("select title from missions where id = $1", [f.missionId]);
        const [ownIssue] = await blocker.unsafe("select title from issues where id = $1", [f.issueId]);
        expect(ownMission.title).toBe("Uncommitted mission");
        expect(ownIssue.title).toBe("Uncommitted oversight");
        expect(await missionReadState(db, f)).toEqual(before);
      } finally {
        try { await blocker.unsafe("rollback"); } finally { blocker.release(); released = true; }
      }
      expect(released).toBe(true);
      expect(await missionReadState(db, f)).toEqual(before);
    },
  );

  it("preserves stored filters, company isolation, ordering ties and pagination", async () => {
    const { db } = testDb;
    const f = await seedTerminalTransaction(db, true);
    const foreign = await seedTerminalTransaction(db, true);
    const projectId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: f.companyId, name: "Filter project" });
    await db.update(companies).set({ timezone: "Asia/Seoul" }).where(eq(companies.id, f.companyId));
    const earlier = new Date("2026-10-08T14:59:59Z"), boundary = new Date("2026-10-08T15:00:00Z");
    await db.update(missions).set({ title: "Alpha", createdAt: boundary, projectId }).where(eq(missions.id, f.missionId));
    const low = "10000000-0000-4000-8000-000000000001", high = "20000000-0000-4000-8000-000000000002";
    await db.insert(missions).values([
      { id: low, companyId: f.companyId, ownerAgentId: f.mission.ownerAgentId, title: "Beta", status: "active", projectId, createdAt: boundary },
      { id: high, companyId: f.companyId, ownerAgentId: f.mission.ownerAgentId, title: "Beta", status: "active", projectId, createdAt: boundary },
      { companyId: f.companyId, ownerAgentId: f.mission.ownerAgentId, title: "Before", status: "active", createdAt: earlier },
      { companyId: f.companyId, ownerAgentId: f.mission.ownerAgentId, title: "Paused", status: "paused", createdAt: boundary },
      { companyId: f.companyId, ownerAgentId: f.mission.ownerAgentId, title: "After", status: "active", createdAt: new Date("2026-10-09T15:00:00Z") },
    ]);
    const filter = { companyId: f.companyId, status: "active" as const, from: "2026-10-09", to: "2026-10-09", sortBy: "title" as const, sortOrder: "asc" as const };
    const svc = missionService(db);
    expect((await svc.list(filter)).map((row) => row.id)).toEqual([f.missionId, high, low]);
    expect((await svc.list({ ...filter, limit: 1, offset: 1 })).map((row) => row.id)).toEqual([high]);
    expect((await svc.list({ ...filter, limit: 1 })).map((row) => row.id)).toEqual([f.missionId]);
    expect((await svc.list({ ...filter, offset: 2 })).map((row) => row.id)).toEqual([low]);
    expect((await svc.list({ ...filter, ownerAgentId: f.mission.ownerAgentId, projectId })).map((row) => row.id)).toEqual([f.missionId, high, low]);
    expect(await svc.list({ ...filter, ownerAgentId: foreign.mission.ownerAgentId })).toEqual([]);
    expect(await svc.list({ ...filter, projectId: randomUUID() })).toEqual([]);
    expect(await svc.list({ ...filter, goalId: randomUUID() })).toEqual([]);
    const response = await request(missionReaderApp(db, f)).get(`/api/companies/${f.companyId}/missions`).query({ status: "active", from: "2026-10-09", to: "2026-10-09", sortBy: "title", sortOrder: "asc", limit: 1, offset: 1 });
    expect(response.status).toBe(200);
    expect(response.body).toEqual([expect.objectContaining({ id: high, status: "active", project: { id: projectId, name: "Filter project", color: null } })]);
  });

  it("denies foreign-company detail/list without changing either company's stored state", async () => {
    const { db, trace } = testDb;
    const own = await seedTerminalTransaction(db, true), foreign = await seedTerminalTransaction(db, true);
    const before = [await missionReadState(db, own), await missionReadState(db, foreign)];
    const app = missionReaderApp(db, own);
    for (const path of [`/api/missions/${foreign.missionId}`, `/api/companies/${foreign.companyId}/missions`]) {
      const start = trace.length;
      const response = await request(app).get(path);
      expect(response.status).toBe(403);
      expect(trace.slice(start).filter(({ query }) => !/^\s*select\s/i.test(query))).toEqual([]);
      expect([await missionReadState(db, own), await missionReadState(db, foreign)]).toEqual(before);
    }
  });

  it("preserves malformed/missing identity and invalid-filter errors without writes", async () => {
    const { db, trace } = testDb;
    const f = await seedTerminalTransaction(db, true);
    const svc = missionService(db), app = missionReaderApp(db, f);
    const before = await missionReadState(db, f), start = trace.length;
    for (const [id, status] of [["not-a-uuid", 400], [randomUUID(), 404]] as const) {
      await expect(svc.getById(id)).rejects.toMatchObject({ status });
      expect((await request(app).get(`/api/missions/${id}`)).status).toBe(status);
    }
    expect((await request(app).get(`/api/companies/${f.companyId}/missions?status=invalid`)).status).toBe(400);
    expect((await request(app).get(`/api/companies/${f.companyId}/missions?from=not-a-date`)).status).toBe(400);
    expect(trace.slice(start).filter(({ query }) => !/^\s*select\s/i.test(query))).toEqual([]);
    expect(await missionReadState(db, f)).toEqual(before);
  });
});
