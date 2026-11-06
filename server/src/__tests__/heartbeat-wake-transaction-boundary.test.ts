import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRuns,
  instanceSettings,
  issues,
  type Db,
} from "@paperclipai/db";
import { heartbeatService } from "../services/heartbeat.js";
import {
  createReplacementRootNotifications,
  queueIssueAssignmentWakeup,
  withReplacementRootNotificationDb,
} from "../services/issue-assignment-wakeup.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

// [T17b] #551 "wake before root commit" 회귀 고정.
//
// 실제 경로: workflow sync 가 이슈를 만들고 applyIssueCreatedSideEffects →
// queueIssueAssignmentWakeup → heartbeat.wakeup 을 호출한다. 이 호출이 호출자의
// 트랜잭션(db) 안에서 일어날 때 커밋 전에 실행이 시작되거나 커밋 전 행이 다른
// 커넥션에 보이면, 롤백된 업무가 실제 실행으로 새어 나간다.
//
// production 동작은 바꾸지 않고 트랜잭션 경계만 고정한다:
//   1) root 가 소유한 tx(root notification context) 안의 wake 는 같은 tx 에서만
//      보이고 peer 에는 0건이다.
//   2) 커밋 전 실행(claim)은 일어나지 않는다 — run 은 queued 로만 남고 agent 는
//      idle 이며, 승격 책임은 root drain 으로 등록된다(root_deferred).
//   3) 커밋 후에도 스스로 실행되지 않고 wake 1건 + queued run 1건만 남는다.
//   4) rollback 시 wake·run·activity 잔여가 0건이다.
//   5) root context 없는 순수 외부 tx 호출은 fail-closed 로 거절되어 아무것도
//      남기지 않는다(조용한 실행 누출 경로가 없음).
//
// wake 옵션은 queueIssueAssignmentWakeup(issue-assignment-wakeup.ts:115-166)이
// 실제로 넘기는 assignment 형태를 그대로 쓴다.

let db: Db;
let peer: Db;
let root: string;
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
const agentIds = new Set<string>();

beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("heartbeat-wake-transaction-");
  db = createDb(temp.connectionString);
  peer = createDb(temp.connectionString);
  root = await mkdtemp(path.join(os.tmpdir(), "heartbeat-wake-transaction-"));
  vi.stubEnv("PAPERCLIP_HOME", root);
  vi.stubEnv("PAPERCLIP_STORAGE_PROVIDER", "local_disk");
  vi.stubEnv("PAPERCLIP_STORAGE_LOCAL_DIR", path.join(root, "storage"));
  vi.stubEnv("PAPERCLIP_SECRETS_MASTER_KEY", "11".repeat(32));
  await db.insert(instanceSettings).values({ singletonKey: "default" });
}, 60_000);

afterEach(async () => {
  if (agentIds.size) {
    // 어떤 케이스도 실행을 시작하지 않아야 하지만, 다음 케이스를 위해 상태를 되돌린다.
    await db.update(agents).set({ status: "paused" }).where(inArray(agents.id, [...agentIds]));
  }
  agentIds.clear();
}, 60_000);

afterAll(async () => {
  await db?.$client.end();
  await peer?.$client.end();
  await temp?.cleanup();
  if (root) await rm(root, { recursive: true, force: true });
  vi.unstubAllEnvs();
}, 60_000);

async function seedAssignment() {
  const companyId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "Wake transaction boundary",
    issuePrefix: "W" + companyId.replaceAll("-", "").slice(0, 8),
  });
  const [agent] = await db.insert(agents).values({
    companyId,
    name: "Assignee",
    status: "idle",
    adapterType: "codex_local",
    adapterConfig: { cwd: root, promptTemplate: "Wake transaction boundary fixture" },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1 } },
  }).returning();
  const [issue] = await db.insert(issues).values({
    companyId,
    title: "Assigned inside a caller transaction",
    assigneeAgentId: agent!.id,
    status: "todo",
  }).returning();
  agentIds.add(agent!.id);
  return { companyId, agent: agent!, issue: issue! };
}

function assignmentWakeOptions(seed: { issue: { id: string } }) {
  // queueIssueAssignmentWakeup 의 assignment 경로와 같은 모양.
  return {
    source: "assignment" as const,
    triggerDetail: "system" as const,
    reason: "issue_assigned",
    payload: { issueId: seed.issue.id, mutation: "create" },
    requestedByActorType: "system" as const,
    requestedByActorId: "workflow",
    contextSnapshot: { issueId: seed.issue.id, source: "workflow_run" },
  };
}

const reads = {
  wakes: (d: Db, companyId: string) =>
    d.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId)),
  runs: (d: Db, companyId: string) =>
    d.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId)),
  activity: (d: Db, companyId: string) =>
    d.select().from(activityLog).where(eq(activityLog.companyId, companyId)),
};

it("keeps a root-owned transaction wake invisible and unexecuted until commit", async () => {
  const seed = await seedAssignment();
  const notifications = createReplacementRootNotifications();

  const run = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    return withReplacementRootNotificationDb(t, notifications, async () => {
      const queued = await heartbeatService(t).wakeup(seed.agent.id, assignmentWakeOptions(seed));

      // (1) tx 안에서는 정확히 한 건의 wake 와 그에 연결된 queued run 만 보인다.
      const txWakes = await reads.wakes(t, seed.companyId);
      const txRuns = await reads.runs(t, seed.companyId);
      expect(txWakes).toHaveLength(1);
      expect(txRuns).toHaveLength(1);
      expect(txWakes[0]).toMatchObject({ status: "queued", runId: txRuns[0]!.id, error: null });
      expect(txRuns[0]).toMatchObject({ status: "queued", startedAt: null, finishedAt: null });
      expect(queued?.id).toBe(txRuns[0]!.id);

      // (2) 커밋 전 실행(claim)은 없다 — 승격은 root drain 으로 넘어가고
      //     agent 는 idle 이며 running run 이 0건이다.
      expect(notifications.agentIds.has(seed.agent.id)).toBe(true);
      const txRunning = await t
        .select()
        .from(heartbeatRuns)
        .where(and(eq(heartbeatRuns.companyId, seed.companyId), inArray(heartbeatRuns.status, ["running"])));
      expect(txRunning).toHaveLength(0);
      const [txAgent] = await t.select().from(agents).where(eq(agents.id, seed.agent.id));
      expect(txAgent!.status).toBe("idle");

      // (3) 커밋 전에는 다른 커넥션(peer)에 wake·run·activity 가 하나도 보이지 않는다.
      expect(await reads.wakes(peer, seed.companyId)).toHaveLength(0);
      expect(await reads.runs(peer, seed.companyId)).toHaveLength(0);
      expect(await reads.activity(peer, seed.companyId)).toHaveLength(0);

      return queued;
    });
  });
  expect(run).not.toBeNull();

  // (4) 커밋 후에는 정확히 한 번만 보이고, 커밋만으로 실행이 시작되지는 않는다.
  const wakes = await reads.wakes(peer, seed.companyId);
  const runs = await reads.runs(peer, seed.companyId);
  expect(wakes).toHaveLength(1);
  expect(runs).toHaveLength(1);
  expect(wakes[0]).toMatchObject({ status: "queued", runId: runs[0]!.id });
  expect(runs[0]).toMatchObject({ id: run!.id, status: "queued", startedAt: null });
  const [agent] = await peer.select().from(agents).where(eq(agents.id, seed.agent.id));
  expect(agent!.status).toBe("idle");
}, 30_000);

it("leaves no wake, run, or activity residue when the caller transaction rolls back", async () => {
  const seed = await seedAssignment();
  const notifications = createReplacementRootNotifications();

  await expect(db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    await withReplacementRootNotificationDb(t, notifications, async () => {
      const queued = await heartbeatService(t).wakeup(seed.agent.id, assignmentWakeOptions(seed));
      expect(queued).not.toBeNull();
    });
    throw new Error("caller transaction rolled back");
  })).rejects.toThrow("caller transaction rolled back");

  expect(await reads.wakes(peer, seed.companyId)).toHaveLength(0);
  expect(await reads.runs(peer, seed.companyId)).toHaveLength(0);
  expect(await reads.activity(peer, seed.companyId)).toHaveLength(0);
  const [agent] = await peer.select().from(agents).where(eq(agents.id, seed.agent.id));
  expect(agent!.status).toBe("idle");
}, 30_000);

it("fails closed for a caller transaction that has no root drain owner", async () => {
  const seed = await seedAssignment();

  // 실제 신호 경로(queueIssueAssignmentWakeup)가 tx 안에서 root owner 없이 wake 를
  // 만들려 하면, claim 단계가 QaCorrectionRootOwnerRequired 로 거절하고 그 예외는
  // queueIssueAssignmentWakeup 이 그대로 다시 던진다. 호출자 tx 는 롤백되고
  // wake·run·activity 어느 것도 커밋되지 않는다.
  const failure = await db.transaction(async (tx) => {
    const t = tx as unknown as Db;
    return queueIssueAssignmentWakeup({
      heartbeat: { wakeup: heartbeatService(t).wakeup },
      issue: seed.issue,
      reason: "issue_assigned",
      mutation: "create",
      contextSource: "workflow_run",
    });
  }).then(
    () => null,
    (error: unknown) => error,
  );
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).name).toBe("QaCorrectionRootOwnerRequired");

  expect(await reads.wakes(peer, seed.companyId)).toHaveLength(0);
  expect(await reads.runs(peer, seed.companyId)).toHaveLength(0);
  expect(await reads.activity(peer, seed.companyId)).toHaveLength(0);
  const [issue] = await peer.select().from(issues).where(eq(issues.id, seed.issue.id));
  expect(issue!.status).toBe("todo");
}, 30_000);
