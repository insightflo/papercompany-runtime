// [레거시 호환 2026-11-12] PR #703(e0116f92, 사람 카드 축소 Stage 1) 이전에 발행된 구조화
// mission_owner_human_input 카드(be79dd99 계열)의 C08 게이트 호환 회귀 테스트.
// 시나리오: 실제 가드 경로로 축소 카드를 만든 뒤 행 내용을 PR #703 직전 빌더 출력으로
// 치환해 "배포 전 생성 카드가 배포 후에도 pending" 상태를 재현한다(production 사고 재현).
// 검증: ① 구형 카드 resolve/currentness/GET current/replay 전부 통과, ② 신규 생성은 여전히
// Stage 1 축소 형식, ③ 변조(해시 미갱신·해시 재계산 모두) 카드는 여전히 409 거부.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, missions,
  operatorDecisions, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { saveOwnerHumanRequest, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { recordMissionOwnerDecision } from "../services/missions/mission-owner-recovery-ledger.js";
import { buildMissionOwnerHumanInputDecisionCard, createMissionOwnerHumanInputDecisionCard,
  type MissionOwnerHumanInputCardSpec } from "../services/missions/mission-owner-human-input-card.js";
import { buildPreCompactMissionOwnerHumanInputDecisionCard } from "../services/missions/mission-owner-human-input-card-precompact.js";
import { assertOwnerHumanDecisionCurrent } from "../services/operator-decision-currentness.js";
import type { OwnerHumanTx } from "../services/missions/owner-human-request-contract.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";
import { stripOperatorDecisionServerContext } from "../services/operator-decision-server-context.js";
import { publishLiveEvent } from "../services/live-events.js";

vi.mock("../services/live-events.js", () => ({ publishLiveEvent: vi.fn() }));
const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
type World = { companyId: string; missionId: string; agentId: string;
  ownerActionIssueId: string; heartbeatRunId: string; sourceId: string };
type Row = typeof operatorDecisions.$inferSelect;

// be79dd99 제출과 같은 다문장 원문 — 줄바꿈·URL 포함.
const submission = {
  decision: "request_input" as const,
  reason: "재계획이 승인 없이 실행에 반영되지 않았습니다.\n사람 방향 확인이 필요합니다.",
  nextAction: "재계획(rev2)을 승인하고 실행을 이어가 주세요.",
  evidence: "원천 이슈 본문과 플랜 리비전 비교 근거.\nhttps://example.com/evidence/precompact-legacy",
};

describeDb("pre-#703 structured human card compatibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let other: Db;
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("c08-precompact-");
    db = createDb(database.connectionString);
    other = createDb(database.connectionString);
  }, 60_000);
  afterAll(async () => {
    await other?.$client.end({ timeout: 5 });
    await db?.$client.end({ timeout: 5 });
    await database?.cleanup();
  });

  async function world(): Promise<World> {
    const w = { companyId: randomUUID(), missionId: randomUUID(), agentId: randomUUID(),
      ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID(), sourceId: randomUUID() };
    await db.insert(companies).values({ id: w.companyId, name: "Precompact legacy", issuePrefix: randomUUID() });
    await db.insert(agents).values({ id: w.agentId, companyId: w.companyId, name: "Owner", status: "active" });
    await db.insert(missions).values({ id: w.missionId, companyId: w.companyId,
      ownerAgentId: w.agentId, title: "Precompact legacy", status: "active" });
    await db.insert(issues).values([
      { id: w.sourceId, companyId: w.companyId, missionId: w.missionId, title: "Source", status: "blocked" },
      { id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId, title: "Owner action",
        status: "in_progress", assigneeAgentId: w.agentId, originKind: "mission_main_executor_unblock", originId: w.sourceId },
    ]);
    await db.insert(heartbeatRuns).values({ id: w.heartbeatRunId, companyId: w.companyId,
      agentId: w.agentId, issueId: w.ownerActionIssueId, status: "running" });
    return w;
  }
  const authority = (w: World) => ({ companyId: w.companyId, missionId: w.missionId,
    ownerActionIssueId: w.ownerActionIssueId, agentId: w.agentId, heartbeatRunId: w.heartbeatRunId });
  async function write(w: World, key = "A", expected: string | null = null, connection = db) {
    return connection.transaction(async (tx) => {
      const auth = await lockOwnerHumanRequestAuthority(tx, authority(w));
      const original = await recordMissionOwnerDecision({ db: tx, issue: {
        id: w.ownerActionIssueId, companyId: w.companyId, missionId: w.missionId,
      }, submission, sourceIssueId: w.sourceId, heartbeatRunId: w.heartbeatRunId });
      return saveOwnerHumanRequest(auth, { schemaVersion: 1, requestKey: key,
        expectedCurrentLifetimeId: expected, identityMode: "keyed", decisionEventId: original.eventId, submission });
    });
  }
  const spec = (saved: OwnerHumanCurrentRecord): MissionOwnerHumanInputCardSpec => ({
    ...saved.lifetime.cardInput, lifetimeId: saved.lifetime.lifetimeId,
  });
  const create = (saved: OwnerHumanCurrentRecord, connection = db) =>
    createMissionOwnerHumanInputDecisionCard(connection, spec(saved));
  const row = async (id: string): Promise<Row> => {
    const [found] = await db.select().from(operatorDecisions).where(eq(operatorDecisions.id, id));
    if (!found) throw new Error("card row missing");
    return found;
  };
  /** 실제 가드 경로로 축소 카드를 만든 뒤, 행을 PR #703 직전 빌더 출력으로 치환해
   *  구 배포 시점에 생성된 pending 카드(be79dd99 상태)를 재현한다. */
  async function ageToPreCompact(saved: OwnerHumanCurrentRecord) {
    const created = await create(saved);
    expect(created.replayed).toBe(false);
    const legacy = buildPreCompactMissionOwnerHumanInputDecisionCard(spec(saved));
    const hashed = validateAndHashOperatorDecisionCreate(legacy);
    await db.update(operatorDecisions).set({
      title: legacy.title, description: legacy.description, definition: legacy.definition,
      requestHash: hashed.requestHash, updatedAt: new Date(),
    }).where(eq(operatorDecisions.id, created.decision.id));
    return { id: created.decision.id, legacy, hashed };
  }
  const resolveGate = (card: Row) => db.transaction(async (tx) =>
    assertOwnerHumanDecisionCurrent(tx as unknown as OwnerHumanTx, card));
  const readCurrent = (w: World) => readOwnerHumanRequest({ db, companyId: w.companyId,
    issueId: w.ownerActionIssueId, actor: { actorType: "agent", actorId: w.agentId,
      agentId: w.agentId, runId: w.heartbeatRunId } });

  it("resolves a pending pre-#703 card through the C08 currentness gate", async () => {
    const w = await world(), saved = await write(w), aged = await ageToPreCompact(saved);
    await expect(resolveGate(await row(aged.id))).resolves.toBeUndefined();
  });

  it("serves the pre-#703 card as the current owner-recovery decision (GET current)", async () => {
    const w = await world(), saved = await write(w), aged = await ageToPreCompact(saved);
    const projection = await readCurrent(w);
    expect(projection.card).toMatchObject({ id: aged.id, status: "pending" });
  });

  it("replays the same lifetime onto the pre-#703 card without rewriting it", async () => {
    const w = await world(), saved = await write(w), aged = await ageToPreCompact(saved);
    const again = await create(saved, other);
    expect(again.replayed).toBe(true);
    expect(again.decision.id).toBe(aged.id);
    const after = await row(aged.id);
    expect(after.description).toBe(aged.legacy.description);
    expect(after.definition).toEqual(aged.legacy.definition);
    expect(after.requestHash).toBe(aged.hashed.requestHash);
  });

  it("still rejects a tampered pre-#703 card (stale hash)", async () => {
    const w = await world(), saved = await write(w), aged = await ageToPreCompact(saved);
    await db.update(operatorDecisions).set({ description: `${aged.legacy.description}\n변조된 문서` })
      .where(eq(operatorDecisions.id, aged.id));
    await expect(resolveGate(await row(aged.id))).rejects.toMatchObject({ status: 409 });
  });

  it("still rejects a tampered pre-#703 card with a self-consistent recomputed hash", async () => {
    const w = await world(), saved = await write(w), aged = await ageToPreCompact(saved);
    const forged = await row(aged.id);
    const tampered = { ...aged.legacy, definition: { ...aged.legacy.definition,
      options: aged.legacy.definition.options.map((option) => option.id === "approve"
        ? { ...option, label: "변조된 승인" } : option) } };
    const tamperedRow = { ...forged, definition: tampered.definition };
    const rebuilt = validateAndHashOperatorDecisionCreate({
      schemaVersion: tamperedRow.schemaVersion, requestKey: tamperedRow.requestKey,
      priority: tamperedRow.priority, interactionType: tamperedRow.interactionType,
      title: tamperedRow.title, description: tamperedRow.description,
      sourceType: tamperedRow.sourceType, sourceId: tamperedRow.sourceId,
      sourceContext: stripOperatorDecisionServerContext(tamperedRow.sourceContext),
      definition: tamperedRow.definition, issueId: tamperedRow.issueId,
      continuationMode: tamperedRow.continuationMode });
    await db.update(operatorDecisions).set({ definition: tampered.definition, requestHash: rebuilt.requestHash })
      .where(eq(operatorDecisions.id, aged.id));
    await expect(resolveGate(await row(aged.id))).rejects.toMatchObject({ status: 409 });
  });

  it("keeps issuing new cards in the Stage 1 compact format", async () => {
    const w = await world(), saved = await write(w);
    const compact = buildMissionOwnerHumanInputDecisionCard(spec(saved));
    const review = compact.definition.humanReview!;
    expect(typeof review.symptom).toBe("string");
    expect(review.symptom).toContain("재계획이 승인 없이 실행에 반영되지 않았습니다.");
    expect(compact.description).not.toContain("요청 사유:");
    expect(review.interpretation).not.toContain("\n");
    expect(review.interpretation.length).toBeLessThanOrEqual(200);
    expect(review.evidence[0]!.description).toBe("상세 진단·근거 원문은 이 이슈 본문에서 확인해 주세요");
    const created = await create(saved);
    const stored = await row(created.decision.id);
    expect(stored.description).toBe(compact.description);
    expect(stored.definition).toEqual(compact.definition);
  });
});

describe("pre-#703 builder fidelity (be79dd99-shaped input)", () => {
  // be79dd99 실측 형태: workflowRunId 로 restart-workflow-from-start[0] + approve[1] 기본 정의,
  // 다문장 reason/nextAction/evidence, 원천 이슈·근거 URL 포함.
  const legacySpec: MissionOwnerHumanInputCardSpec = {
    companyId: randomUUID(), missionId: randomUUID(), decisionEventId: randomUUID(),
    decision: "request_input", ownerActionIssueId: randomUUID(), ownerActionIssueStatus: "in_progress",
    requestedByAgentId: randomUUID(),
    reason: "재계획이 승인 없이 실행에 반영되지 않았습니다.\n사람 방향 확인이 필요합니다.",
    nextAction: "재계획(rev2)을 승인하고 실행을 이어가 주세요.",
    evidence: "원천 이슈 본문과 플랜 리비전 비교 근거.\nhttps://example.com/evidence/precompact-legacy",
    issueTitle: "Owner action", issueIdentifier: "RES-10926", sourceIssueId: randomUUID(),
    workflowRunId: randomUUID(),
  };

  it("reproduces the pre-#703 structured output byte-shape", () => {
    const legacy = buildPreCompactMissionOwnerHumanInputDecisionCard(legacySpec);
    const review = legacy.definition.humanReview!;
    expect(Object.hasOwn(review, "symptom")).toBe(false);
    expect(legacy.definition.options[0]!.id).toBe("restart-workflow-from-start");
    expect(legacy.definition.options[1]!.id).toBe("approve");
    for (const line of [
      `요청 사유: ${legacySpec.reason}`,
      `요청된 다음 단계: ${legacySpec.nextAction}`,
      `오너 제출 근거: ${legacySpec.evidence}`,
    ]) expect(legacy.description).toContain(line);
    expect(review.interpretation).toContain(`요청 사유: ${legacySpec.reason}`);
    expect(review.evidence[0]!.description).toBe(legacySpec.reason);
    expect(review.evidence.at(-1)!.description).toBe(legacySpec.evidence);
    expect(review.evidence.at(-1)!.href).toBe("https://example.com/evidence/precompact-legacy");
  });

  it("preserves raw multi-line structured option descriptions where the compact builder flattens them", () => {
    const structured: MissionOwnerHumanInputCardSpec = { ...legacySpec, workflowRunId: null,
      structuredOptions: [{ id: "custom-option", label: "사용자 정의 선택지",
        description: "첫 줄 설명입니다.\n둘째 줄 상세 설명이 이어집니다." }] };
    const legacy = buildPreCompactMissionOwnerHumanInputDecisionCard(structured);
    const compact = buildMissionOwnerHumanInputDecisionCard(structured);
    expect(legacy.definition.options[0]!.description).toContain("\n");
    expect(compact.definition.options[0]!.description).not.toContain("\n");
    expect(validateAndHashOperatorDecisionCreate(legacy).requestHash)
      .not.toBe(validateAndHashOperatorDecisionCreate(compact).requestHash);
  });

  it("differs from the compact output for the same input", () => {
    const legacy = buildPreCompactMissionOwnerHumanInputDecisionCard(legacySpec);
    const compact = buildMissionOwnerHumanInputDecisionCard(legacySpec);
    expect(validateAndHashOperatorDecisionCreate(legacy).requestHash)
      .not.toBe(validateAndHashOperatorDecisionCreate(compact).requestHash);
    expect(compact.definition.humanReview!.symptom).toBeTruthy();
  });
});
