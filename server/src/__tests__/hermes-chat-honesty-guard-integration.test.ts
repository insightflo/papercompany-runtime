import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { activityLog, companies, createDb, heartbeatRuns } from "@paperclipai/db";

import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { applyRunHonestyCaveat, hermesChatService } from "../services/hermes-chat.js";

// [목적] applyRunHonestyCaveat의 proof가 activity_log.runId FK로 exact 매칭하는지 검증.
//   이전 issue_comments(authorAgentId+창) 휴리스틱이 같은 agent의 다른-run 댓글을 false-positive proof로
//   인식해 caveat를 잘못 빼던 hole(peer review)이 activity_log exact proof로 막혔는지 확인.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres honesty-guard integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("applyRunHonestyCaveat (activity_log exact proof)", () => {
  let db: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let agentId: string;
  let companyId: string;
  let thisRunId: string;
  let otherRunId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-honesty-guard-");
    db = createDb(tempDb.connectionString);

    companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Honesty Guard Co",
      issuePrefix: `HG${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    const ensured = await hermesChatService(db).ensureOperationsAgent(companyId);
    agentId = ensured.id;

    const [r1] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId })
      .returning({ id: heartbeatRuns.id });
    const [r2] = await db
      .insert(heartbeatRuns)
      .values({ companyId, agentId })
      .returning({ id: heartbeatRuns.id });
    thisRunId = r1.id;
    otherRunId = r2.id;
  }, 60_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  it("appends caveat when the agent's comment was logged under a DIFFERENT run (no false-positive proof)", async () => {
    // 다른 run이 댓글 relay를 남김 → 이 run(thisRunId)의 proof는 0 → caveat 부착.
    await db.insert(activityLog).values({
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      companyId,
      runId: otherRunId,
    });

    const body = await applyRunHonestyCaveat(db, { id: thisRunId }, "RES-1076 에이전트를 깨웠습니다.");
    expect(body).toContain("[서버 검증]");
    expect(body).toContain("확인되지 않았습니다");
  });

  it("appends caveat when a diagnostic supervision run is claimed as executor wake", async () => {
    await db.insert(activityLog).values({
      actorType: "agent",
      actorId: agentId,
      action: "mission.supervision.run",
      entityType: "mission",
      entityId: randomUUID(),
      agentId,
      companyId,
      runId: thisRunId,
      details: {
        appliedActionCount: 0,
        dispatchOwnerDecisionWakeups: false,
        dispatchStaleSourceIssueWakeups: false,
      },
    });

    const body = await applyRunHonestyCaveat(
      db,
      { id: thisRunId },
      "미션 owner supervision을 다시 걸어 main executor를 깨웠습니다.",
    );
    expect(body).toContain("[서버 검증]");
    expect(body).toContain("확인되지 않았습니다");
  });

  it("does NOT append caveat when THIS run logged the claimed comment (activity_log.runId = run.id)", async () => {
    await db.insert(activityLog).values({
      actorType: "agent",
      actorId: agentId,
      action: "issue.comment_added",
      entityType: "issue",
      entityId: randomUUID(),
      agentId,
      companyId,
      runId: thisRunId,
    });

    const body = await applyRunHonestyCaveat(db, { id: thisRunId }, "RES-1076에 댓글을 남겼습니다.");
    expect(body).toBe("RES-1076에 댓글을 남겼습니다.");
  });
});
