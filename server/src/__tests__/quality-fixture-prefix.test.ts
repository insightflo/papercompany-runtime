import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { companies } from "@paperclipai/db";
import { createQaCorrectionTestDb } from "./helpers/qa-correction-fixture.js";
import { seedQualityFixture } from "./helpers/quality-fixture.js";

// 각 생성 직전 회사 ID 두 개만 제어하고, 나머지 UUID와 DB·정책 처리는 실제 경로를 사용한다.
const { companyIds } = vi.hoisted(() => ({ companyIds: [] as string[] }));
vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return {
    ...actual,
    randomUUID: () => companyIds.shift() ?? actual.randomUUID(),
  };
});

let owned: Awaited<ReturnType<typeof createQaCorrectionTestDb>>;
beforeAll(async () => {
  owned = await createQaCorrectionTestDb();
}, 60_000);
afterAll(async () => {
  await owned?.close();
}, 60_000);

// C12와 doc/PRODUCT.md의 다중 회사 요구: 서로 다른 회사와 각 정책·그룹은 같은 DB에 공존해야 한다.
// 접두사 계산식을 정답으로 복제하지 않고 실제 회사 행과 고유 제약을 통해 확인한다.
it("distinct company UUIDs sharing the first four hex digits can coexist in actual fixtures", async () => {
  const first = [
    "11110000-0000-4000-8000-000000000001",
    "22220000-0000-4000-8000-000000000001",
  ];
  const second = [
    "11110000-0000-4000-8000-000000000002",
    "22220000-0000-4000-8000-000000000002",
  ];
  expect(first.map(id => id.slice(0, 4))).toEqual(second.map(id => id.slice(0, 4)));
  expect(new Set([...first, ...second]).size).toBe(4);
  expect(companyIds).toEqual([]);

  companyIds.push(...first);
  const a = await seedQualityFixture(owned.db);
  expect([a.companyId, a.otherCompanyId]).toEqual(first);
  expect(companyIds).toEqual([]);

  companyIds.push(...second);
  const b = await seedQualityFixture(owned.db);
  expect([b.companyId, b.otherCompanyId]).toEqual(second);
  expect(companyIds).toEqual([]);

  const rows = await owned.db.select().from(companies)
    .where(inArray(companies.id, [...first, ...second]));
  expect(rows).toHaveLength(4);
  expect(new Set(rows.map(row => row.issuePrefix)).size).toBe(4);
  expect(a.policyVersionId).not.toBe(b.policyVersionId);
  expect(a.groupId).not.toBe(b.groupId);
});
