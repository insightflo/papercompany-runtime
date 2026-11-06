import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatMaintenanceActivityCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal }: HeartbeatBudgetCaseContext) {
  it("does not attach maintenance guidance or decision to a GitHub PR review in a business company", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();
    let invocationContext: Record<string, unknown> | undefined;
    await db.insert(companies).values({
      id: companyId,
      name: "Repository Review Company",
      issuePrefix: "INF",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Runtime Repository Steward",
      role: "repository_steward",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Review the pull request." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Runtime review mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      identifier: "INF-293",
      title: "[insightflo/papercompany-runtime #88] Add human-readable approval review packets",
      description: "<!-- papercompany-github-bridge:source=github -->\nPull request imported from GitHub.\n\n- Repository: insightflo/papercompany-runtime\n- Number: #88\n- Revision: 21a7691cc84aef1250dab6f0147129b8821c62a4",
      status: "todo",
      assigneeAgentId: agentId,
      originKind: "manual",
    });

    executeSpy.mockImplementation(async ({ context }) => {
      invocationContext = structuredClone(context) as Record<string, unknown>;
      return successfulAdapterResult();
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, note: "review the exact PR revision" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    expect(invocationContext?.paperclipMaintenanceGuidance).toBeUndefined();
    expect(invocationContext?.paperclipMaintenanceDecision).toBeUndefined();

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(auditRows.some((row) => row.action === "maintenance_decision_evaluated")).toBe(false);
  });

  it("records vendor maintenance decisions as heartbeat audit activity", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      companyKind: "maintenance",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Vendor Audit Agent",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Follow the heartbeat." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PG사 external API 오류",
      description: "오늘 11:00부터 결제 vendor timeout, 증상: approval failed",
      status: "todo",
    });

    executeSpy.mockResolvedValue({
      exitCode: 0,
      signal: null,
      timedOut: false,
      errorMessage: null,
      usage: null,
      provider: "test",
      model: "test-model",
      resultJson: null,
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId, note: "vendor check" }, "manual", {
      actorType: "system",
      actorId: "test-suite",
    });

    expect(run).not.toBeNull();
    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");
    await new Promise((resolve) => setTimeout(resolve, 50));

    const auditRows = await db
      .select()
      .from(activityLog)
      .where(eq(activityLog.runId, run!.id));
    expect(auditRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "maintenance_decision_evaluated",
          entityType: "issue",
          entityId: issueId,
          agentId,
          runId: run!.id,
          details: expect.objectContaining({
            issueId,
            runId: run!.id,
            recommendedNextAction: "vendor_handoff",
            suggestedStatus: "in_progress",
            requiredInputs: [],
            warnings: [],
            handoffTarget: "vendor",
            matchedRules: expect.arrayContaining([
              expect.objectContaining({ id: "maintenance-vendor-handoff", action: "vendor_handoff" }),
            ]),
          }),
        }),
      ]),
    );
  });
}
