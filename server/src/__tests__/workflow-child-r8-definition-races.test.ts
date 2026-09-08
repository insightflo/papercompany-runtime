// @vitest-environment node
// [workflow-child r8 finding 1 — definition races] 설계 r8 §1 admission-race 스위트. 잠금 순서:
//   claim 은 비잠금 P 예독 → 정렬 정의 FOR SHARE → P FOR UPDATE → 드리프트 비교. /tmp/wfw8-next/
//   locks.test.ts 의 3 SAFE 컨트롤 포트(부모/대상 × archive/물리 DELETE 확장), PID 식별
//   pg_stat_activity 실제 대기 증거의 raw archive/DELETE lock-wait 가드, 부모 정의 드리프트,
//   same-ID/self-cycle 유한 종료. 경합 증명은 실제 트랜잭션과 구조화 SQLSTATE 만 사용한다.
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { Db } from "@paperclipai/db";
import {
  activityLog,
  agents,
  companies,
  createDb,
  issueComments,
  issues,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowStepInvocations,
  workflowStepRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  claimChildInvocation,
  type ClaimChildInvocationInput,
  type InvocationClaim,
} from "../services/workflow/workflow-child-invocation-claim.js";
import { archiveWorkflowDefinitionWithGuard } from "../services/workflow/workflow-definition-delete-guard.js";
import {
  childStep,
  configureWorkflowChildFixtures,
  createCompanyFixture,
  insertDefinition,
  insertRunWithWorkflowStepRun,
} from "./helpers/workflow-child-fixtures.js";
import { insertLinkedInvocation } from "./helpers/workflow-child-invocation-fixtures.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

let db: ReturnType<typeof createDb>;
let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

type Suite = { companyId: string; childDefId: string; parentDefId: string; runId: string; stepRunId: string };

/** 자식 정의 + 부모 정의(child 스텝) + running run/pending 스텝 — invocation/자식 run 없음. */
async function baseSuite(name: string): Promise<Suite> {
  const companyId = await createCompanyFixture(name);
  const childDefId = await insertDefinition({
    companyId, name: `${name}-child`,
    steps: [{ id: "a", name: "A", type: "agent", agentId: "", dependencies: [] }],
  });
  const parentDefId = await insertDefinition({ companyId, name: `${name}-parent`, steps: [childStep(childDefId)] });
  const { runId, stepRunId } = await insertRunWithWorkflowStepRun({ companyId, workflowId: parentDefId });
  return { companyId, childDefId, parentDefId, runId, stepRunId };
}

async function claimInputOf(x: Suite, targetWorkflowId = x.childDefId): Promise<ClaimChildInvocationInput> {
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId));
  // 클레임은 input.run 에서 id 만 신원 확인용으로 읽는다 — cascade 삭제로 행이 사라져도 커밋 후
  // ineligible 재확인이 가능해야 하므로 id 스텁으로 대체한다.
  const runRow = run ?? ({ id: x.runId } as typeof workflowRuns.$inferSelect);
  return {
    companyId: x.companyId, run: runRow, parentStepRunId: x.stepRunId,
    stepId: "run-child", generation: 1, targetWorkflowId, renderedInputs: {}, now: new Date(),
  };
}

const childRunsOf = (companyId: string) =>
  db.select().from(workflowRuns).where(and(eq(workflowRuns.companyId, companyId), eq(workflowRuns.triggerSource, "workflow")));

function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`bounded completion exceeded: ${label}`)), ms);
    promise.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

/** 클레임을 통제 가능한 홀드 트랜잭션으로 연다 — entered 결과 확인 후 release 로 커밋을 허가한다. */
function holdClaim(input: ClaimChildInvocationInput) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let enter!: (claim: InvocationClaim) => void;
  let fail!: (error: unknown) => void;
  const entered = new Promise<InvocationClaim>((resolve, reject) => { enter = resolve; fail = reject; });
  const holder = db.transaction(async (tx) => {
    const result = await claimChildInvocation(tx as unknown as Db, input);
    enter(result);
    await gate;
  }).catch((error: unknown) => { fail(error); throw error; });
  return { holder, release, entered };
}

type RemovalMode = "app-archive" | "raw-archive" | "raw-delete";

/** 경합 중의 유한 제거 시도 — 앱 가드 내장 500ms 또는 tx-local lock_timeout 500ms 로 경계짓는다. */
async function attemptBoundedRemoval(mode: RemovalMode, defId: string): Promise<unknown> {
  const untouched = () => { throw new Error("removal was not blocked"); };
  if (mode === "app-archive") {
    return archiveWorkflowDefinitionWithGuard(db, defId).then(() => untouched(), (error: unknown) => error);
  }
  return db.transaction(async (tx) => {
    await tx.execute(sql`set local lock_timeout = '500ms'`);
    if (mode === "raw-delete") await tx.execute(sql`delete from workflow_definitions where id = ${defId}`);
    else await tx.execute(sql`update workflow_definitions set status = 'archived' where id = ${defId}`);
  }).then(() => untouched(), (error: unknown) => error);
}

const errorCodeOf = (error: unknown) => (error as { code?: string }).code;
const messageOf = (error: unknown) => (error as Error).message;

/** 실제 Lock 대기 관측 — pid 지정 시 해당 백엔드, null 이면 임의 백엔드. 대기자 식별은 PID/
 *  wait_event_type 기준이며 쿼리 텍스트 매칭은 쓰지 않는다. 경계 시간 초과는 실패다. */
async function observeLockWait(pid: number | null, label: string): Promise<void> {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const rows = await db.execute(pid === null
      ? sql`select wait_event_type from pg_stat_activity where wait_event_type = 'Lock' limit 1`
      : sql`select wait_event_type from pg_stat_activity where pid = ${pid}`);
    if ((rows[0] as { wait_event_type?: string | null } | undefined)?.wait_event_type === "Lock") return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`lock wait not observed for ${label}`);
}

type ReservedSql = { (strings: TemplateStringsArray, ...values: unknown[]): Promise<Record<string, unknown>[]>; release(): void };
type PoolWithReserve = { reserve(): Promise<ReservedSql>; end(): Promise<void> };
const poolOf = (instance: unknown) => (instance as { $client: PoolWithReserve }).$client;

describeEmbeddedPostgres("workflow child r8 — definition admission/removal races", () => {
  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wfw-r8-defraces-");
    db = createDb(tempDb.connectionString);
    configureWorkflowChildFixtures(db);
  }, 60_000);

  afterEach(async () => {
    for (const table of [activityLog, issueComments, issues, missions, workflowStepInvocations, workflowStepRuns, workflowRuns, workflowDefinitions, agents, companies]) {
      await db.delete(table);
    }
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  // [SAFE 포트 1] 커밋 전 클레임이 정의 FOR SHARE 를 쥐면 제거는 막히고(app 409 busy / raw 55P03),
  // 클레임 커밋 후 제거는 활성 invocation 으로 거부된다. 부모/대상 × archive/물리 DELETE.
  it.each([
    { role: "target", mode: "app-archive" }, { role: "target", mode: "raw-delete" },
    { role: "parent", mode: "app-archive" }, { role: "parent", mode: "raw-delete" },
  ] as const)("uncommitted claim blocks $mode of the $role definition; committed claim refuses it", async ({ role, mode }) => {
    const x = await baseSuite(`Races C1 ${role} ${mode}`);
    const defId = role === "target" ? x.childDefId : x.parentDefId;
    const { holder, release, entered } = holdClaim(await claimInputOf(x));
    try {
      expect((await entered).outcome).toBe("created");
      const blocked = await attemptBoundedRemoval(mode, defId);
      if (mode === "app-archive") expect(messageOf(blocked)).toContain("workflow_definition_archival_busy");
      else expect(errorCodeOf(blocked)).toBe("55P03");
    } finally {
      release();
      await holder;
    }
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
    if (mode === "app-archive") {
      await expect(archiveWorkflowDefinitionWithGuard(db, defId)).rejects.toThrow("workflow_definition_has_active_child_invocations");
    } else {
      await expect(db.execute(sql`delete from workflow_definitions where id = ${defId}`)).rejects.toMatchObject({ code: "23514" });
    }
    expect((await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, defId)))[0]?.status).toBe("active");
  }, 30_000);

  // [SAFE 포트 2] 제거가 정의 잠금을 먼저 쥐면 클레임은 busy 를 양보하고, 커밋 후엔 ineligible —
  // invocation/자식 run 을 하나도 만들지 않는다(교착 없음).
  it.each([
    { role: "target", mode: "raw-archive" }, { role: "target", mode: "raw-delete" },
    { role: "parent", mode: "raw-archive" }, { role: "parent", mode: "raw-delete" },
  ] as const)("uncommitted $mode of the $role definition excludes the claim (busy, then ineligible, no creation)", async ({ role, mode }) => {
    const x = await baseSuite(`Races C2 ${role} ${mode}`);
    const defId = role === "target" ? x.childDefId : x.parentDefId;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.transaction(async (tx) => {
      if (mode === "raw-delete") await tx.execute(sql`delete from workflow_definitions where id = ${defId}`);
      else await tx.execute(sql`update workflow_definitions set status = 'archived' where id = ${defId}`);
      ready();
      await gate;
    });
    try {
      await bounded(held, 5000, "removal holder");
      expect((await claimChildInvocation(db, await claimInputOf(x))).outcome).toBe("busy");
    } finally {
      release();
      await holder;
    }
    expect((await claimChildInvocation(db, await claimInputOf(x))).outcome).toBe("ineligible");
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childRunsOf(x.companyId)).toHaveLength(0);
    const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, defId));
    if (mode === "raw-archive") expect(definition?.status).toBe("archived");
    else expect(definition).toBeUndefined();
  }, 30_000);

  // [SAFE 포트 3] deferred 커밋 트리거 — claimed+NULL 커밋은 23514 로 기계 차단되고, linked 자식의
  // 물리 삭제는 tombstone(linked+NULL)을 보존한다.
  it("deferred commit rejects claimed+NULL; linked child deletion preserves tombstone", async () => {
    const x = await baseSuite("Races C3 Deferred");
    const inv = await insertLinkedInvocation(db, {
      companyId: x.companyId, parentRunId: x.runId, parentStepRunId: x.stepRunId, childWorkflowId: x.childDefId,
    });
    await expect(db.transaction(async (tx) => {
      await tx.update(workflowStepInvocations).set({ state: "claimed", childRunId: null }).where(eq(workflowStepInvocations.id, inv.invocationId));
    })).rejects.toMatchObject({ code: "23514" });
    expect((await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, inv.invocationId)))[0]?.state).toBe("linked");
    await db.delete(workflowRuns).where(eq(workflowRuns.id, inv.childRunId));
    expect((await db.select().from(workflowStepInvocations).where(eq(workflowStepInvocations.id, inv.invocationId)))[0])
      .toMatchObject({ state: "linked", childRunId: null });
  });

  // [lock-wait 가드] raw archive/DELETE 가 클레임의 정의 FOR SHARE 뒤에서 "실제로 대기"함을
  // 백엔드 PID 로 관측하고, 클레임 커밋 후 대기가 풀리며 활성 invocation 으로 23514 거부된다.
  // 새 제거 호출도 여전히 거부한다. 대기자 식별은 PID 기준(쿼리 텍스트 매칭 금지).
  it.each(["raw-archive", "raw-delete"] as const)("lock-wait: %s on the target definition waits on the claim's FOR SHARE (PID-observed), then refuses", async (mode) => {
    const x = await baseSuite(`Races Wait ${mode}`);
    const { holder, release, entered } = holdClaim(await claimInputOf(x));
    const remover = createDb(tempDb!.connectionString);
    const pool = poolOf(remover);
    const conn = await pool.reserve();
    try {
      expect((await entered).outcome).toBe("created");
      const [pidRow] = await conn`select pg_backend_pid()::int4 as pid`;
      const pid = Number(pidRow?.pid);
      const removal = mode === "raw-delete"
        ? conn`delete from workflow_definitions where id = ${x.childDefId}`
        : conn`update workflow_definitions set status = 'archived' where id = ${x.childDefId}`;
      removal.catch(() => {});
      await observeLockWait(pid, `${mode} remover`);
      release();
      await expect(removal).rejects.toMatchObject({ code: "23514" });
    } finally {
      release();
      await holder.catch(() => {});
      await conn.release();
      await pool.end();
    }
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(1);
    await expect(archiveWorkflowDefinitionWithGuard(db, x.childDefId)).rejects.toThrow("workflow_definition_has_active_child_invocations");
    expect((await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, x.childDefId)))[0]?.status).toBe("active");
  }, 30_000);

  // [발견→잠금 드리프트] 클레임이 P 예독 후 P FOR UPDATE 대기에 진입했음을 Lock 관측으로 확인하고,
  // 그 사이 별도 트랜잭션에서 부모 run 의 workflow_id 를 donor 로 바꾸면 클레임은 ineligible 로
  // 종료한다 — admission/자식 행 없음, 새 정의를 기회적으로 잠그지 않는다.
  it("claim parent-definition drift between discovery and locking returns ineligible with no admission", async () => {
    const x = await baseSuite("Races Drift");
    const donorDefId = await insertDefinition({ companyId: x.companyId, name: "drift-donor", steps: [] });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let ready!: () => void;
    const held = new Promise<void>((resolve) => { ready = resolve; });
    const holder = db.transaction(async (tx) => {
      await tx.select().from(workflowRuns).where(eq(workflowRuns.id, x.runId)).for("update");
      ready();
      await gate;
      await tx.update(workflowRuns).set({ workflowId: donorDefId }).where(eq(workflowRuns.id, x.runId));
    });
    try {
      await bounded(held, 5000, "drift holder");
      const claim = claimChildInvocation(db, await claimInputOf(x));
      claim.catch(() => {});
      await observeLockWait(null, "drift claim at parent FOR UPDATE");
      release();
      expect((await bounded(claim, 10_000, "drift claim")).outcome).toBe("ineligible");
    } finally {
      release();
      await holder;
    }
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childRunsOf(x.companyId)).toHaveLength(0);
    expect((await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, x.parentDefId)))[0]?.status).toBe("active");
  }, 30_000);

  // [same-ID/self-cycle] 대상 = 부모 정의 입력은 예독 단계의 기존 검증 경로에서 ineligible 로
  // 유한 종료한다(교착 없음, 자식 행 없음).
  it("same-definition/self-cycle input terminates bounded with no child creation", async () => {
    const x = await baseSuite("Races SelfCycle");
    const claim = await bounded(claimChildInvocation(db, await claimInputOf(x, x.parentDefId)), 8000, "self-cycle claim");
    expect(claim.outcome).toBe("ineligible");
    expect(await db.select().from(workflowStepInvocations)).toHaveLength(0);
    expect(await childRunsOf(x.companyId)).toHaveLength(0);
  }, 15_000);
});
