import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createDb,
  missions,
  workflowDefinitions,
  workflowRuns,
  workflowRunSlots,
} from "@paperclipai/db";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";
import { countCompanyRunState, seedRunInputWorkflow } from "./helpers/workflow-run-input-fixture.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";

// workflow-manual-run-mission-label.test.ts 와 동일한 wakeup-mock 경계(외부 경계만 mock,
// 실제 엔진·미션·스토어·슬롯 클레임 유지).
const { heartbeatWakeup } = vi.hoisted(() => ({
  heartbeatWakeup: vi.fn(),
}));

vi.mock("../services/heartbeat.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat.js")>();
  return {
    ...actual,
    heartbeatService: () => ({
      wakeup: heartbeatWakeup,
    }),
  };
});

vi.mock("../services/issue-assignment-wakeup.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/issue-assignment-wakeup.js")>();
  return {
    ...actual,
    queueIssueAssignmentWakeup: (
      input: Parameters<typeof actual.queueIssueAssignmentWakeup>[0],
    ) => actual.queueIssueAssignmentWakeup({
      ...input,
      heartbeat: { wakeup: heartbeatWakeup },
    }),
  };
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEP = embeddedPostgresSupport.supported ? describe : describe.skip;
if (!embeddedPostgresSupport.supported) {
  console.warn(`Skipping workflow run input scheduler tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const scheduledFields: WorkflowRunInput[] = [
  {
    key: "section",
    type: "radio",
    options: [
      { value: "manuals", label: "매뉴얼" },
      { value: "concepts", label: "개념 설명" },
    ],
    default: "manuals",
  },
  { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
  { key: "enabled", type: "switch", default: true },
];

describeEP("workflow scheduler run input controls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wf-run-input-scheduler-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  beforeEach(() => {
    heartbeatWakeup.mockReset();
    heartbeatWakeup.mockResolvedValue({ id: "test-wakeup" });
  });

  afterAll(async () => {
    try { await db?.$client.end({ timeout: 5 }); }
    finally { await tempDb?.cleanup(); }
  });

  it("stores undeclared defaults on the scheduled run metadata", async () => {
    const seed = await seedRunInputWorkflow(db, scheduledFields, "0 6 * * *");
    const result = await workflowService.claimScheduledRun(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      scheduledAt: new Date("2026-09-08T01:00:00Z"),
      runDate: "2026-09-08",
      metadata: { enabled: false },
    });
    expect(result.claimed).toBe(true);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.run!.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({
      section: "manuals",
      tags: ["a"],
      enabled: false,
    }));
    expect(stored!.triggerSource).toBe("schedule");
    expect(stored!.runDate).toBe("2026-09-08");
    expect(stored!.scheduledSlotId).toBeTruthy();
  });

  it("rejects an invalid required control and replays the same scheduledAt to the same failed slot", async () => {
    const seed = await seedRunInputWorkflow(db, [
      scheduledFields[0],
      { key: "enabled", type: "switch", required: true },
    ], "0 6 * * *");
    const claimInput = {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      scheduledAt: new Date("2026-09-08T01:00:00Z"),
      runDate: "2026-09-08",
      metadata: { enabled: "sometimes" },
    };
    await expect(workflowService.claimScheduledRun(db, claimInput)).rejects.toThrow();
    const slots = await db
      .select()
      .from(workflowRunSlots)
      .where(eq(workflowRunSlots.workflowDefinitionId, seed.workflowId));
    expect(slots).toHaveLength(1);
    expect(slots[0]).toEqual(expect.objectContaining({
      companyId: seed.companyId,
      status: "failed",
    }));
    const stateAfterFailure = await countCompanyRunState(
      db,
      seed.companyId,
      heartbeatWakeup.mock.calls.length,
    );
    expect(stateAfterFailure).toEqual({ missions: 0, runs: 0, issues: 0, stepRuns: 0, wakeups: 0 });

    // [I1] 실패 슬롯 뒤에는 활성 미션이 없으므로, 동일 scheduledAt 재청구의 claimed:false는
    // 활성-미션 가드가 아니라 슬롯 충돌 do-nothing 경계에서 나와야 한다. 재시도 의미 추가 없이
    // 기존 결과만 단언한다.
    const replay = await workflowService.claimScheduledRun(db, claimInput);
    expect(replay.claimed).toBe(false);
    expect(replay.scheduledSlotId).toBeNull();
    expect(replay.run).toBeNull();
    const slotsAfterReplay = await db
      .select()
      .from(workflowRunSlots)
      .where(eq(workflowRunSlots.workflowDefinitionId, seed.workflowId));
    expect(slotsAfterReplay).toHaveLength(1);
    expect(slotsAfterReplay[0]!.id).toBe(slots[0]!.id);
    expect(slotsAfterReplay[0]).toEqual(expect.objectContaining({ status: "failed" }));
    const stateAfterReplay = await countCompanyRunState(
      db,
      seed.companyId,
      heartbeatWakeup.mock.calls.length,
    );
    expect(stateAfterReplay).toEqual(stateAfterFailure);

    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, seed.workflowId));
    expect(storedRuns).toHaveLength(0);
    const companyMissions = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, seed.companyId));
    expect(companyMissions).toHaveLength(0);
    const [definition] = await db
      .select()
      .from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, seed.workflowId));
    expect(definition!.lastScheduleError).toBeTruthy();
    expect(heartbeatWakeup).not.toHaveBeenCalled();
  });

  it("keeps one run when the same scheduledAt is claimed again", async () => {
    const seed = await seedRunInputWorkflow(db, scheduledFields, "0 6 * * *");
    const claimInput = {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      scheduledAt: new Date("2026-09-08T01:00:00Z"),
      runDate: "2026-09-08",
      metadata: { enabled: false },
    };
    const first = await workflowService.claimScheduledRun(db, claimInput);
    expect(first.claimed).toBe(true);
    const second = await workflowService.claimScheduledRun(db, claimInput);
    expect(second.claimed).toBe(false);
    expect(second.run).toBeNull();
    const storedRuns = await db
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.workflowId, seed.workflowId));
    expect(storedRuns).toHaveLength(1);
  });

  it("does not add a scheduler text-required gate for plain required text", async () => {
    const seed = await seedRunInputWorkflow(db, [
      { key: "topic", label: "주제", required: true },
      scheduledFields[0],
      { key: "enabled", type: "switch" },
    ], "0 6 * * *");
    const result = await workflowService.claimScheduledRun(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      scheduledAt: new Date("2026-09-08T02:00:00Z"),
      runDate: "2026-09-08",
      metadata: { section: "manuals", enabled: false },
    });
    expect(result.claimed).toBe(true);
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.run!.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({ section: "manuals", enabled: false }));
    expect(stored!.metadata).not.toHaveProperty("topic");
  });

  it("applies defaults to a plugin-style trigger call without metadata", async () => {
    const seed = await seedRunInputWorkflow(db, [
      scheduledFields[0],
      { key: "enabled", type: "switch", default: true },
    ], "0 6 * * *");
    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "plugin",
    });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({
      section: "manuals",
      enabled: true,
    }));
  });
});
