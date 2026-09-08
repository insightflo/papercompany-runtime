import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createDb, missions, workflowRuns } from "@paperclipai/db";
import type { WorkflowRunInput } from "@paperclipai/shared/validators/workflow-run-inputs";
import {
  countCompanyRunState,
  seedRunInputWorkflow,
} from "./helpers/workflow-run-input-fixture.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { workflowService } from "../services/workflow/engine.js";

// workflow-manual-run-mission-label.test.ts 와 동일한 wakeup-mock 경계: trigger()는
// 스텝 이슈를 만들고 assignment wakeup을 큐에 넣는다. 외부 wakeup만 부분 mock하고
// 엔진·미션·스토어·Drizzle·DAG 이슈 생성은 실제 코드를 쓴다.
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
  console.warn(`Skipping workflow run input trigger tests: ${embeddedPostgresSupport.reason ?? "unsupported"}`);
}

const baseFields: WorkflowRunInput[] = [
  { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }], default: "manuals" },
  { key: "enabled", type: "switch", default: true },
  { key: "tags", type: "checkbox", required: false, options: [{ value: "a", label: "A" }], default: ["a"] },
];

describeEP("workflow trigger run input controls", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("wf-run-input-trigger-");
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

  it("applies declared defaults and keeps explicit typed values on manual trigger", async () => {
    const seed = await seedRunInputWorkflow(db, baseFields);
    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      runLabel: "검증",
      metadata: { enabled: false, tags: [], untouched: 17 },
    });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(stored!.metadata).toEqual(expect.objectContaining({
      section: "manuals",
      enabled: false,
      tags: [],
      untouched: 17,
    }));
    expect(stored!.runLabel).toBe("검증");
    expect(stored!.metadata).not.toHaveProperty("runLabel");
    const companyMissions = await db
      .select({ id: missions.id })
      .from(missions)
      .where(eq(missions.companyId, seed.companyId));
    expect(companyMissions.map((mission) => mission.id)).toContain(stored!.missionId);
  });

  it.each([
    { url: "https://youtu.be/dQw4w9WgXcQ", expected: "dQw4w9WgXcQ" },
    { url: "https://www.youtube.com/watch?v=kJQP7kiw5Fk&t=42s", expected: "kJQP7kiw5Fk" },
    { url: "https://www.youtube.com/shorts/aqz-KE__pSM?si=x", expected: "aqz-KE__pSM" },
  ])("derives youtube video id from $url on trigger", async (item) => {
    const seed = await seedRunInputWorkflow(db, [
      { key: "url", label: "영상 URL" },
      { key: "videoId", label: "영상 ID", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ]);
    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata: { url: item.url },
    });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(stored!.metadata).toMatchObject({ url: item.url, videoId: item.expected });
  });

  it("keeps an explicitly provided derived value instead of re-extracting", async () => {
    const seed = await seedRunInputWorkflow(db, [
      { key: "url", label: "영상 URL" },
      { key: "videoId", label: "영상 ID", deriveFrom: { input: "url", extract: "youtubeVideoId" } },
    ]);
    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata: { url: "https://youtu.be/dQw4w9WgXcQ", videoId: "explicitID1" },
    });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(stored!.metadata).toMatchObject({ url: "https://youtu.be/dQw4w9WgXcQ", videoId: "explicitID1" });
  });

  it.each([
    {
      name: "null value for a radio control",
      runInputs: [
        { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }], default: "manuals" },
      ] satisfies WorkflowRunInput[],
      metadata: { section: null },
    },
    {
      name: "wrong type for a switch control",
      runInputs: [{ key: "enabled", type: "switch" }] satisfies WorkflowRunInput[],
      metadata: { enabled: "yes" },
    },
    {
      name: "unknown radio selection",
      runInputs: [
        { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }] },
      ] satisfies WorkflowRunInput[],
      metadata: { section: "podcasts" },
    },
    {
      name: "duplicate checkbox values",
      runInputs: [
        { key: "tags", type: "checkbox", options: [{ value: "a", label: "A" }] },
      ] satisfies WorkflowRunInput[],
      metadata: { tags: ["a", "a"] },
    },
    {
      name: "missing required switch",
      runInputs: [{ key: "enabled", type: "switch", required: true }] satisfies WorkflowRunInput[],
      metadata: {},
    },
    {
      name: "empty array for a required checkbox",
      runInputs: [
        { key: "tags", type: "checkbox", required: true, options: [{ value: "a", label: "A" }] },
      ] satisfies WorkflowRunInput[],
      metadata: { tags: [] },
    },
  ])("rejects $name with no writes and no wakeups", async ({ runInputs, metadata }) => {
    const seed = await seedRunInputWorkflow(db, runInputs);
    const before = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    await expect(workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata,
    })).rejects.toThrow();
    const after = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
    expect(after.runs).toBe(0);
    expect(after.missions).toBe(0);
  });

  it("rejects a wrong-company trigger before input errors and writes nothing", async () => {
    const seed = await seedRunInputWorkflow(db, baseFields);
    const other = await seedRunInputWorkflow(db, []);
    const beforeTarget = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    const beforeOther = await countCompanyRunState(db, other.companyId, heartbeatWakeup.mock.calls.length);
    await expect(workflowService.trigger(db, {
      companyId: other.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata: { section: "not-an-option", enabled: "nope" },
    })).rejects.toThrow(/does not belong to company/i);
    const afterTarget = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    const afterOther = await countCompanyRunState(db, other.companyId, heartbeatWakeup.mock.calls.length);
    expect(afterTarget).toEqual(beforeTarget);
    expect(afterOther).toEqual(beforeOther);
  });

  it("rejects a missing workflow definition without writes", async () => {
    const seed = await seedRunInputWorkflow(db, baseFields);
    const before = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    await expect(workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: randomUUID(),
      triggeredBy: "board",
      metadata: {},
    })).rejects.toThrow(/not found/i);
    const after = await countCompanyRunState(db, seed.companyId, heartbeatWakeup.mock.calls.length);
    expect(after).toEqual(before);
  });

  it("still accepts omitted required plain text on the manual path without placeholder leakage", async () => {
    const seed = await seedRunInputWorkflow(db, [
      { key: "topic", label: "주제", required: true, placeholder: "https://youtu.be/dQw4w9WgXcQ" },
      { key: "section", type: "radio", options: [{ value: "manuals", label: "매뉴얼" }], default: "manuals" },
    ]);
    const result = await workflowService.trigger(db, {
      companyId: seed.companyId,
      workflowId: seed.workflowId,
      triggeredBy: "board",
      metadata: {},
    });
    const [stored] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, result.runId));
    expect(stored).toBeDefined();
    expect(stored!.metadata).not.toHaveProperty("topic");
    expect(JSON.stringify(stored!.metadata)).not.toContain("dQw4w9WgXcQ");
  });
});
