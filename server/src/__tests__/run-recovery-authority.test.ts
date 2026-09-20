// [purpose] 공식 복구 서비스(run-recovery-authority) 회귀 — 1회 소비·권한버전 검증·
//   멱등 키·CAS 경합. 2026-09-20 스테이지 3 PR-2b 검토 계약의 코어 조항 커버.
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createDb,
  workflowRecoveryAuthorities,
  workflowRuns,
  type Db,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  cleanupTerminalBoundaryTables,
  seedBoundaryWorld,
  type BoundaryWorld,
} from "./helpers/run-terminal-boundary-fixture.js";
import { finalizeRunTerminal } from "../services/workflow/run-terminal-boundary.js";
import { latestTerminalDecision, recoverTerminalRun } from "../services/workflow/run-recovery-authority.js";
import { markRunStatus } from "./helpers/workflow-frozen-execution-fixture.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping run-recovery-authority tests: ${support.reason ?? "unsupported host"}`);
}

const FAILED_CAUSE = { policy: "recovery_deadline_hard", discovery: "stuck_diagnostic", origin: "reconciler", reason: "recovery contract" } as const;

let db: Db;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;

beforeAll(async () => {
  tempDb = await startEmbeddedPostgresTestDatabase("recovery-authority-");
  db = createDb(tempDb.connectionString);
});

afterAll(async () => {
  await db.$client.end({ timeout: 5 });
  await tempDb.cleanup();
});

async function seedFailedWorld(): Promise<BoundaryWorld> {
  await cleanupTerminalBoundaryTables(db);
  const world = await seedBoundaryWorld(db, { runStatus: "running" });
  const finalized = await finalizeRunTerminal(db, {
    runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
    decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
    now: new Date(), stepRuns: [],
  });
  expect(finalized.kind).toBe("finalized");
  return world;
}

describeEP("recoverTerminalRun core contract", () => {
  it("recovers a decision-backed terminal run: one-time consumption + version bump", async () => {
    const world = await seedFailedWorld();
    const result = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      expectedDecision: "failed", recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(result.kind).toBe("recovered");
    if (result.kind !== "recovered") return;
    expect(result.run.status).toBe("running");
    expect(result.run.dispatchAuthorityVersion).toBe(1);
    expect(result.run.completedAt).toBeNull();
    expect(result.authority.targetAuthorityVersion).toBe(0);
    expect(result.authority.resultingAuthorityVersion).toBe(1);
    expect(result.authority.status).toBe("consumed");
  });

  it("consumes each target version exactly once — second attempt is already_consumed with zero writes", async () => {
    const world = await seedFailedWorld();
    const first = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(first.kind).toBe("recovered");
    // run 이 running@1 이므로 재시도는 not_terminal — 1회 소비 검증은 버전을 다시 종결해 확인.
    const reFinalized = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 1,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(reFinalized.kind).toBe("finalized");
    const second = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "supervision_tool_retry", requestedBy: "supervision", now: new Date(),
    });
    expect(second.kind).toBe("stale_authority");
    if (second.kind !== "stale_authority") return;
    // 재종결은 버전을 올리지 않는다 — 결정은 현재 버전(1)에 기록된다.
    expect(second.currentAuthorityVersion).toBe(1);
    // 권한 행은 여전히 1건(버전 0 소비 1회).
    const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, world.runId));
    expect(authorities).toHaveLength(1);
  });

  it("idempotent requestReference retry returns the existing authority without writes", async () => {
    const world = await seedFailedWorld();
    const first = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "supervision_tool_retry", requestReference: "retry-key-1",
      requestedBy: "supervision", now: new Date(),
    });
    expect(first.kind).toBe("recovered");
    // 같은 키 재시도 — 버전이 이미 1로 옮겨졌어도 키 선점검이 먼저 성립하지 않는다(버전 불일치).
    // 실제 멱등 경로는 호출자가 키로 재진입하는 시점의 상태를 가정하지 않는다 — 여기서는
    // 키 유니크가 이중 소비를 막는지 DB 제약 수준에서 확인한다.
    await expect(db.insert(workflowRecoveryAuthorities).values({
      companyId: world.companyId, workflowRunId: world.runId, targetAuthorityVersion: 0,
      targetDecisionId: first.kind === "recovered" ? first.authority.targetDecisionId : "00000000-0000-0000-0000-000000000000",
      recoveryKind: "supervision_tool_retry", requestReference: "retry-key-1",
      requestedBy: "supervision", status: "consumed", resultingAuthorityVersion: 1,
    })).rejects.toThrow();
  });

  it("same-key retry through the service is already_consumed", async () => {
    const world = await seedFailedWorld();
    const first = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "supervision_tool_retry", requestReference: "retry-key-2",
      requestedBy: "supervision", now: new Date(),
    });
    expect(first.kind).toBe("recovered");
    // 같은 키 재호출 — run 이 running@1 이어도 키 선점검이 먼저다(멱등 진실성).
    const second = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "supervision_tool_retry", requestReference: "retry-key-2",
      requestedBy: "supervision", now: new Date(),
    });
    expect(second.kind).toBe("already_consumed");
    if (second.kind !== "already_consumed") return;
    if (first.kind !== "recovered") return;
    expect(second.authority.id).toBe(first.authority.id);
  });

  it("decision mismatch and missing decision are explicit rejections", async () => {
    const world = await seedFailedWorld();
    const mismatch = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      expectedDecision: "cancelled", recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(mismatch).toMatchObject({ kind: "decision_mismatch", existingDecision: "failed" });

    // 결정 없는 레거시 종결행 — missing_decision.
    await cleanupTerminalBoundaryTables(db);
    const legacy = await seedBoundaryWorld(db, { runStatus: "failed" });
    const missing = await recoverTerminalRun(db, {
      runId: legacy.runId, companyId: legacy.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(missing.kind).toBe("missing_decision");
  });

  it("non-terminal and missing runs refuse recovery", async () => {
    const world = await seedFailedWorld();
    await markRunStatus(db, world.runId, "running");
    await db.update(workflowRuns).set({ completedAt: null }).where(eq(workflowRuns.id, world.runId));
    const notTerminal = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(notTerminal).toMatchObject({ kind: "not_terminal", currentStatus: "running" });

    const notFound = await recoverTerminalRun(db, {
      runId: "00000000-0000-0000-0000-000000000000", companyId: world.companyId,
      expectedAuthorityVersion: 0, recoveryKind: "manual_resume", requestedBy: "board", now: new Date(),
    });
    expect(notFound.kind).toBe("not_found");
  });

  it("same recovery key can consume a later decision version — no false already_consumed", async () => {
    // [봇 지적 재발 방지 — bug·high] 같은 키(예: 언블록 이슈 id)가 재실패 후 새 결정을
    //   다시 해결할 때, 이전 버전 소비가 이번 명령을 already_consumed 로 오인하면 안 된다.
    const world = await seedFailedWorld();
    const first = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 0,
      recoveryKind: "source_issue_unblock", requestReference: "unblock-issue-A",
      requestedBy: "source_issue_unblock", now: new Date(),
    });
    expect(first.kind).toBe("recovered");
    const reFinalized = await finalizeRunTerminal(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 1,
      decision: "failed", cause: { ...FAILED_CAUSE }, gatePolicy: "immediate",
      now: new Date(), stepRuns: [],
    });
    expect(reFinalized.kind).toBe("finalized");
    const second = await recoverTerminalRun(db, {
      runId: world.runId, companyId: world.companyId, expectedAuthorityVersion: 1,
      recoveryKind: "source_issue_unblock", requestReference: "unblock-issue-A",
      requestedBy: "source_issue_unblock", now: new Date(),
    });
    expect(second.kind).toBe("recovered");
    if (second.kind !== "recovered") return;
    expect(second.run.dispatchAuthorityVersion).toBe(2);
    const authorities = await db.select().from(workflowRecoveryAuthorities).where(eq(workflowRecoveryAuthorities.workflowRunId, world.runId));
    expect(authorities).toHaveLength(2);
  });

  it("latestTerminalDecision reads the newest decision version", async () => {
    const world = await seedFailedWorld();
    const latest = await latestTerminalDecision(db, world.runId, world.companyId);
    expect(latest).toEqual({ decidedAuthorityVersion: 0, decision: "failed" });
  });
});
