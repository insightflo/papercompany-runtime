import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import { activityLog, companies, createDb, issues } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { activityService } from "../services/activity.js";

/**
 * [목적] activity 목록의 "숨긴 이슈 제외" 규칙이 조인 형태를 text 비교에서 uuid 캐스트로
 *        바꾼 뒤에도 같은 행 집합을 돌려주는지 고정한다.
 * [배경] text 비교(`entity_id = issues.id::text`)는 issues pkey를 못 타서 요청마다 전체 스캔이
 *        붙었다(2026-11-07 A1 실측). 캐스트 형태로 바꾸면서 기존 결과가 달라지면 안 된다.
 * [방법] 같은 데이터에 (a) 서비스 결과와 (b) 옛 조인 조건을 그대로 쓴 raw SQL 결과를 나란히 비교한다.
 *        uuid가 아닌 entity_id(레거시 텍스트 참조)도 함께 넣어 캐스트 오류가 나지 않는지 확인한다.
 */
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres activity hidden-issue join tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

const LEGACY_JOIN = sql`
  LEFT JOIN issues i
    ON al.entity_type = 'issue' AND al.entity_id = i.id::text
`;

describeEmbeddedPostgres("activity list hidden-issue join", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-activity-hidden-issue-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seed() {
    const companyId = randomUUID();
    const visibleIssueId = randomUUID();
    const hiddenIssueId = randomUUID();
    const missionId = randomUUID();
    const base = Date.parse("2026-11-07T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip Activity Join",
      issuePrefix: `AJ${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(issues).values([
      { id: visibleIssueId, companyId, title: "Visible issue", status: "todo" },
      { id: hiddenIssueId, companyId, title: "Hidden issue", status: "todo", hiddenAt: new Date(base) },
    ]);
    await db.insert(activityLog).values([
      { companyId, action: "issue.updated", entityType: "issue", entityId: visibleIssueId, createdAt: new Date(base + 4_000) },
      { companyId, action: "issue.updated", entityType: "issue", entityId: hiddenIssueId, createdAt: new Date(base + 3_000) },
      { companyId, action: "issue.updated", entityType: "issue", entityId: "legacy-issue-ref", createdAt: new Date(base + 2_000) },
      { companyId, action: "mission.updated", entityType: "mission", entityId: missionId, createdAt: new Date(base + 1_000) },
      { companyId, action: "agent.updated", entityType: "agent", entityId: "agent-ref", createdAt: new Date(base) },
    ].map((row) => ({ ...row, actorType: "system", actorId: "system" })));

    return { companyId, visibleIssueId, hiddenIssueId, missionId };
  }

  it("returns the same rows as the legacy text join", async () => {
    const { companyId, visibleIssueId, hiddenIssueId } = await seed();

    const actual = await activityService(db).list({ companyId });
    const legacy = await db.execute<{ id: string }>(sql`
      SELECT al.id
      FROM activity_log al
      ${LEGACY_JOIN}
      WHERE al.company_id = ${companyId}
        AND (al.entity_type <> 'issue' OR i.hidden_at IS NULL)
      ORDER BY al.created_at DESC
    `);

    expect(actual.map((row) => row.id)).toEqual(legacy.map((row) => row.id));
    expect(actual.map((row) => row.id)).toHaveLength(4);
    expect(actual.map((row) => row.entityId)).toContain(visibleIssueId);
    expect(actual.map((row) => row.entityId)).toContain("legacy-issue-ref");
    expect(actual.map((row) => row.entityId)).not.toContain(hiddenIssueId);
  });

  it("keeps hiding a filtered issue while returning the visible one", async () => {
    const { companyId, visibleIssueId, hiddenIssueId } = await seed();
    const service = activityService(db);

    const visibleRows = await service.list({ companyId, entityType: "issue", entityId: visibleIssueId });
    const hiddenRows = await service.list({ companyId, entityType: "issue", entityId: hiddenIssueId });

    expect(visibleRows.map((row) => row.entityId)).toEqual([visibleIssueId]);
    expect(hiddenRows).toEqual([]);

    const legacyVisible = await db.execute<{ id: string }>(sql`
      SELECT al.id
      FROM activity_log al
      ${LEGACY_JOIN}
      WHERE al.company_id = ${companyId}
        AND al.entity_type = 'issue'
        AND al.entity_id = ${visibleIssueId}
        AND (al.entity_type <> 'issue' OR i.hidden_at IS NULL)
      ORDER BY al.created_at DESC
    `);
    expect(visibleRows.map((row) => row.id)).toEqual(legacyVisible.map((row) => row.id));
  });
});
