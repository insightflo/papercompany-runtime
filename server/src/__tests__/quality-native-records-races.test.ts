// server/src/__tests__/quality-native-records-races.test.ts
//
// [purpose] T3 경합·재시도 계약: 동시 ensure 수렴, 커밋 후 재호출 재생(무변화),
//   zero-row CAS(깨진 기존 binding)는 전체 rollback.

import { afterAll, beforeAll, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { qualityActions } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb, type QualityTestDb } from "./helpers/quality-db.js";
import { seedQualityFixture, type QualityFixture } from "./helpers/quality-fixture.js";
import { readCanonicalCounts } from "./helpers/quality-proofs.js";
import { ensureCanonicalQualityExecution } from "../services/quality/native-records.js";

describeQualityDb("Quality canonical native records races", () => {
  let owned: QualityTestDb;
  beforeAll(async () => {
    owned = await createQualityTestDb();
  }, 120_000);
  afterAll(async () => { await owned?.close(); });

  it("concurrent ensure calls converge on one binding and one row set", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    const before = await readCanonicalCounts(db, key.companyId);
    const results = await Promise.all([
      ensureCanonicalQualityExecution(db, key),
      ensureCanonicalQualityExecution(db, key),
      ensureCanonicalQualityExecution(db, key),
    ]);
    // jsonb 는 키 순을 정규화한다 — 문자열 직렬화가 아니라 값 동등성으로 수렴을 검사한다.
    expect(results[1]).toEqual(results[0]);
    expect(results[2]).toEqual(results[0]);
    const after = await readCanonicalCounts(db, key.companyId);
    expect(after.missions).toBe(before.missions + 1);
    expect(after.workflowRuns).toBe(before.workflowRuns + 1);
    expect(after.workflowStepRuns).toBe(before.workflowStepRuns + 1);
    expect(after.stepIssues).toBe(before.stepIssues + 1);
    expect(after.oversightIssues).toBe(before.oversightIssues + 1);
    expect(after.boundActions).toBe(before.boundActions + 1);
  });

  it("replays idempotently after a committed binding without new rows", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    const first = await ensureCanonicalQualityExecution(db, key);
    const rows = await readCanonicalCounts(db, key.companyId);
    const second = await ensureCanonicalQualityExecution(db, key);
    expect(second).toEqual(first);
    expect(await readCanonicalCounts(db, key.companyId)).toEqual(rows);
  });

  it("rolls back the whole transaction when the stored binding fails the exact join (zero-row CAS)", async () => {
    const db = owned.db;
    const seeded = await seedQualityFixture(db);
    const key = { companyId: seeded.companyId, actionId: seeded.actionId };
    // 깨진 binding: join 이 실패하는 존재하지 않는 실행 행을 가리킨다. 스냅숏은 깨진 상태 기준.
    await db.update(qualityActions).set({
      canonicalBinding: { companyId: key.companyId, actionId: key.actionId, missionId: "11111111-1111-4111-8111-111111111111", workflowRunId: "22222222-2222-4222-8222-222222222222", stepRunId: "33333333-3333-4333-8333-333333333333", issueId: "44444444-4444-4444-8444-444444444444" },
    }).where(and(eq(qualityActions.companyId, key.companyId), eq(qualityActions.id, key.actionId)));
    const before = await readCanonicalCounts(db, key.companyId);
    await expect(ensureCanonicalQualityExecution(db, key)).rejects.toMatchObject({ status: 409 });
    expect(await readCanonicalCounts(db, key.companyId)).toEqual(before);
  });
});
