import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, issues, missionPlanArtifacts, missionPlanQaVerdicts, missions } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { getMissionRecoveryAdvice } from "../services/missions/mission-recovery-advice.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("comment-language-boundary-"); }, 60_000);
afterAll(async () => { await fixture?.cleanup(); });

describeDb("recovery advice display-language failure boundary", () => {
  it("returns scoped advice without a standalone company lookup, preserving Korean display", async () => {
    const db = createDb(fixture.connectionString);
    const companyId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Language boundary", defaultLanguage: "ko", issuePrefix: `LB${companyId.replace(/-/g, "").slice(0, 8)}` });
    const ownerAgentId = randomUUID();
    await db.insert(agents).values({ id: ownerAgentId, companyId, name: "Owner", role: "operator", adapterType: "codex_local", status: "active" });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId, title: "Recovery boundary", status: "active" });
    const qaIssueId = randomUUID();
    await db.insert(issues).values([
      { id: issueId, companyId, missionId, title: "Producer", status: "done", originKind: "workflow_execution" },
      { id: qaIssueId, companyId, missionId, title: "Plan QA", status: "done", originKind: "mission_plan_qa", originId: issueId },
    ]);
    await db.insert(missionPlanArtifacts).values({ companyId, missionId, ownerAgentId, revision: 1, status: "active", missionGoal: "Boundary proof", refs: { planQa: { issueId: qaIssueId, decisionHash: "current-hash" } } });
    await db.insert(missionPlanQaVerdicts).values({ companyId, missionId, planQaIssueId: qaIssueId, decisionHash: "current-hash", verdict: "request_changes", diagnostics: [{ message: "Required correction" }], sourceCommentId: null });

    // Keep all required queries on the real fixture DB. Only the newly added
    // standalone display lookup is made unavailable; no runtime DB is used.
    let rejectedLookups = 0;
    const guardedDb = new Proxy(db, {
      get(target, property, receiver) {
        if (property !== "select") return Reflect.get(target, property, receiver);
        return (...args: unknown[]) => {
          const query = Reflect.apply(target.select, target, args);
          const from = query.from.bind(query);
          query.from = (table: typeof companies) => {
            if (table === companies) {
              rejectedLookups += 1;
              throw new Error("standalone display-language lookup unavailable");
            }
            return from(table);
          };
          return query;
        };
      },
    });
    const advice = await getMissionRecoveryAdvice(guardedDb, { companyId, missionId, issueId });
    expect(advice.decision).toBe("producer_rework");
    expect(advice.targetIssue?.id).toBe(issueId);
    expect(advice.operatorComment).toMatch(/[가-힣]/);
    expect(rejectedLookups).toBe(0);
  });
});
