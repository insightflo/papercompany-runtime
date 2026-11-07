/**
 * [목적] issueService.list의 기본(summary) 뷰가 이슈 본문(description)을 응답에서 비우되 키는 유지하고,
 *        view:"full"이 기존 페이로드를 그대로 복원하는지 고정한다.
 * [배경] A1 운영 목록 응답 64,658,717 bytes 중 description이 46.54MB(87%)였다. 응답에서만 지우고
 *        Postgres에서는 계속 읽으면 DB→Node 전송 비용이 남으므로 요약 뷰의 행은 description이 null이어야 한다.
 * [검증] (1) 요약 행의 description은 null이고 키는 존재, (2) full 뷰는 같은 순서·같은 실제 본문,
 *        (3) description만 제거하면 두 뷰의 행이 완전히 동일(다른 필드/enrichment 무변경),
 *        (4) limit/offset은 지정했을 때만 적용되고 기대 슬라이스를 돌려준다.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { companies, createDb, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueService } from "../services/issues.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue list summary view tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

// [이유] 본문 길이는 실측 규모(이슈당 평균 수 KB)를 흉내내지 않고, "컬럼을 실제로 읽었는가"만 구분되면 충분하다.
const DESCRIPTION_BODIES = ["alpha", "beta", "gamma"].map((tag) => `${tag}:`.repeat(60));

describeEmbeddedPostgres("issueService.list summary view", () => {
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId!: string;
  let issueIds!: string[];

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issues-list-summary-");
    db = createDb(tempDb.connectionString);
    svc = issueService(db);
  }, 60_000);

  afterEach(async () => {
    await db.delete(issues);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  /**
   * [목적] 3개 이슈를 updatedAt이 서로 다른 상태로 심는다.
   * [이유] 목록 정렬은 priority asc → updatedAt desc이므로 우선순위가 같으면 updatedAt이 순서를 결정한다.
   *        limit/offset 슬라이스를 검증하려면 순서가 결정적이어야 한다.
   */
  async function seedCompanyWithIssues() {
    companyId = randomUUID();
    issueIds = [randomUUID(), randomUUID(), randomUUID()];
    const base = new Date("2026-01-01T00:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Summary View Co",
      issuePrefix: `S${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(issues).values(
      issueIds.map((id, index) => ({
        id,
        companyId,
        title: `Summary view issue ${index + 1}`,
        description: DESCRIPTION_BODIES[index],
        status: "todo",
        priority: "medium",
        // 최신 updatedAt이 목록 맨 앞이다(desc).
        updatedAt: new Date(base.getTime() + index * 60_000),
      })),
    );
  }

  it("omits description values from the default list view while keeping the key", async () => {
    await seedCompanyWithIssues();

    const summaryRows = await svc.list(companyId);

    expect(summaryRows).toHaveLength(3);
    for (const row of summaryRows) {
      expect(Object.hasOwn(row, "description")).toBe(true);
      expect(row.description).toBeNull();
    }
    // 본문은 DB에 남아 있어야 한다(요약 뷰가 값을 지우는 것이 아니라 읽지 않는 것).
    expect((await svc.getById(issueIds[0]))?.description).toBe(DESCRIPTION_BODIES[0]);
  });

  it("returns the exact descriptions in the same order when view=full", async () => {
    await seedCompanyWithIssues();

    const summaryRows = await svc.list(companyId);
    const fullRows = await svc.list(companyId, { view: "full" });

    expect(fullRows.map((row) => row.id)).toEqual(summaryRows.map((row) => row.id));
    for (const row of fullRows) {
      const index = issueIds.indexOf(row.id);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(row.description).toBe(DESCRIPTION_BODIES[index]);
    }
  });

  it("keeps every other field identical between the summary and full views", async () => {
    await seedCompanyWithIssues();

    const summaryRows = await svc.list(companyId);
    const fullRows = await svc.list(companyId, { view: "full" });

    const stripDescription = <T extends { description: string | null }>(row: T) => {
      const { description: _description, ...rest } = row;
      return rest;
    };

    expect(summaryRows.map(stripDescription)).toEqual(fullRows.map(stripDescription));
  });

  it("applies limit and offset only when they are provided", async () => {
    await seedCompanyWithIssues();

    const allRows = await svc.list(companyId);
    expect(allRows).toHaveLength(3);

    const limited = await svc.list(companyId, { limit: 2 });
    expect(limited.map((row) => row.id)).toEqual(allRows.slice(0, 2).map((row) => row.id));

    const paged = await svc.list(companyId, { limit: 2, offset: 1 });
    expect(paged.map((row) => row.id)).toEqual(allRows.slice(1, 3).map((row) => row.id));

    // summary 뷰 계약은 페이지 윈도우에서도 동일하다.
    for (const row of [...limited, ...paged]) {
      expect(Object.hasOwn(row, "description")).toBe(true);
      expect(row.description).toBeNull();
    }
  });
});
