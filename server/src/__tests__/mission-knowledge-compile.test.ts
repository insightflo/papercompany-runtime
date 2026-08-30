import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { activityLog, agents, companies, createDb, issues as issuesTable, missions } from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  buildMissionKnowledgeCompileDescription,
  ensureMissionKnowledgeCompileIssue,
  MISSION_KNOWLEDGE_COMPILE_ORIGIN_KIND,
} from "../services/missions/mission-knowledge-compile.js";
import { knowledgePatternsService } from "../services/knowledge-patterns.js";

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping mission knowledge compile tests: ${support.reason ?? "unsupported"}`);
}

describe("buildMissionKnowledgeCompileDescription (pure)", () => {
  it("renders the conservative rule, card contract with prefilled evidence refs, adoption path, and close instruction", () => {
    const description = buildMissionKnowledgeCompileDescription({
      missionId: "mission-1",
      missionTitle: "저녁 리포트 미션",
      refs: { unblockIssueId: "unblock-1", sourceIssueId: "source-1", workflowRunId: "run-1" },
    });

    expect(description).toContain("at most one pattern card");
    expect(description).toContain("ONLY if the verified root cause was structural");
    expect(description).toContain("POST /api/companies/{companyId}/knowledge-patterns");
    expect(description).toContain('evidence: [{ type: "mission", id: <mission id above> }, { type: "workflow_run", id: <workflow run id above> }]');
    expect(description).toContain("Recovered from: unblock issue unblock-1 (source issue source-1 reached done; workflow run run-1)");
    expect(description).toContain("self-improvement-adoptions/dry-run");
    expect(description).toContain("Do not hand-edit skill markdown");
    expect(description).toContain("close this issue (status done)");
    // 결정 API 착각 방지 — 이 이슈는 owner-recovery/decision 대상이 아니다.
    expect(description).not.toContain("owner-recovery/decision");
  });
});

describeEP("ensureMissionKnowledgeCompileIssue (trigger-side dedup and skip rules)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let ownerAgentId: string;
  let missionId: string;
  let terminalMissionId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("knowledge-compile-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    const [company] = await db.insert(companies).values([
      { id: companyId, name: "Compile Co", status: "active", issuePrefix: "KC1" },
    ]).returning();
    ownerAgentId = randomUUID();
    await db.insert(agents).values({
      id: ownerAgentId, companyId, name: "Mission Owner", role: "owner",
      status: "active", adapterType: "claude_local", adapterConfig: {},
      runtimeConfig: {}, permissions: {},
    });
    missionId = randomUUID();
    terminalMissionId = randomUUID();
    await db.insert(missions).values([
      { id: missionId, companyId, ownerAgentId, title: "활동 미션", status: "active" },
      { id: terminalMissionId, companyId, ownerAgentId, title: "종결 미션", status: "completed" },
    ]);
  }, 60_000);

  afterEach(async () => {
    await db.delete(activityLog);
  });

  afterAll(async () => {
    await db.$client.end({ timeout: 5 });
    await tempDb?.cleanup();
  });

  const refs = { unblockIssueId: "unblock-1", sourceIssueId: "source-1", workflowRunId: "run-1" };

  it("renders the failure-context digest section when a digest is provided", () => {
    const description = buildMissionKnowledgeCompileDescription({
      missionId: "mission-1",
      missionTitle: "저녁 미션",
      refs: { unblockIssueId: "u", sourceIssueId: "s", workflowRunId: "r" },
      missionExecutionDigest: ["Workflow run: gazua-evening status=failed", "  ", ""],
    });
    expect(description).toContain("Failure context (mission execution digest at recovery):");
    expect(description).toContain("- Workflow run: gazua-evening status=failed");
    const without = buildMissionKnowledgeCompileDescription({
      missionId: "mission-1",
      missionTitle: "저녁 미션",
      refs: { unblockIssueId: "u", sourceIssueId: "s", workflowRunId: "r" },
    });
    expect(without).not.toContain("Failure context");
  });

  it("creates a bounded compile issue for an active mission, then dedups and respects card existence and terminal missions", async () => {
    const first = await ensureMissionKnowledgeCompileIssue(db, { companyId, missionId, refs });
    expect(first.created).toBe(true);
    expect(first.issueId).toBeTruthy();

    const [row] = await db.select().from(issuesTable).where(eq(issuesTable.id, first.issueId!));
    expect(row.originKind).toBe(MISSION_KNOWLEDGE_COMPILE_ORIGIN_KIND);
    expect(row.assigneeAgentId).toBe(ownerAgentId);
    expect(row.title).toContain("[Knowledge]");
    expect(row.description).toContain("ONLY if the verified root cause was structural");

    const logs = await db.select().from(activityLog);
    expect(logs.some((entry) => entry.action === "mission.knowledge_compile_issue_created")).toBe(true);

    // 두 번째 호출 — 이슈 중복 방지(모든 상태 포함).
    const second = await ensureMissionKnowledgeCompileIssue(db, { companyId, missionId, refs });
    expect(second.created).toBe(false);
    expect(second.reason).toBe("issue_exists");

    // 종결 미션 — 썩는 이슈 금지.
    const terminal = await ensureMissionKnowledgeCompileIssue(db, { companyId, missionId: terminalMissionId, refs });
    expect(terminal.created).toBe(false);
    expect(terminal.reason).toBe("mission_completed");
  });

  it("embeds a real execution digest when the source issue exists", async () => {
    const otherMissionId = randomUUID();
    await db.insert(missions).values({ id: otherMissionId, companyId, ownerAgentId, title: "다이제스트 미션", description: "저녁 리포트 생산 미션", status: "active" });
    const { issues: issuesTable } = await import("@paperclipai/db");
    const [sourceIssue] = await db.insert(issuesTable).values({
      companyId, missionId: otherMissionId, title: "막혔던 원천 이슈", status: "done",
    }).returning();

    const result = await ensureMissionKnowledgeCompileIssue(db, {
      companyId,
      missionId: otherMissionId,
      refs: { unblockIssueId: "u2", sourceIssueId: sourceIssue!.id, workflowRunId: "r2" },
    });
    expect(result.created).toBe(true);
    const [row] = await db.select().from(issuesTable).where(eq(issuesTable.id, result.issueId!));
    expect(row!.description).toContain("Failure context (mission execution digest at recovery):");
    expect(row!.description).toContain("저녁 리포트 생산 미션");
  });

  it("skips creation when a pattern card already references the mission", async () => {
    const otherMissionId = randomUUID();
    await db.insert(missions).values({ id: otherMissionId, companyId, ownerAgentId, title: "카드 있는 미션", status: "active" });
    await knowledgePatternsService(db).create({
      companyId,
      kind: "failure_mode",
      title: "이미 등록된 사고",
      summary: "카드가 이미 이 미션을 참조한다.",
      evidence: [{ type: "mission", id: otherMissionId }],
      source: "operator",
    });

    const result = await ensureMissionKnowledgeCompileIssue(db, { companyId, missionId: otherMissionId, refs });
    expect(result.created).toBe(false);
    expect(result.reason).toBe("card_exists");
  });

  it("scopes lookups to the requesting company", async () => {
    const foreign = await ensureMissionKnowledgeCompileIssue(db, { companyId: randomUUID(), missionId, refs });
    expect(foreign.created).toBe(false);
    expect(foreign.reason).toBe("mission_not_found");
  });
});
