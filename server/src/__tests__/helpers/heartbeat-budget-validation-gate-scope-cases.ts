import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, activityLog, companies, issueComments, issues, missions } from "@paperclipai/db";
import type { HeartbeatBudgetCaseContext } from "./heartbeat-budget-owner-cases.js";

export function registerHeartbeatValidationGateScopeCases({ getDb, heartbeatService, executeSpy, successfulAdapterResult, waitForRunTerminal, waitForIssueStatus }: HeartbeatBudgetCaseContext) {
  it("does not block a validator PASS result that contains caveat text", async () => {
    const db = getDb();
    const companyId = randomUUID();
    const validatorAgentId = randomUUID();
    const missionId = randomUUID();
    const validatorIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: "PAP",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: validatorAgentId,
      companyId,
      name: "Artifact Validator",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: { promptTemplate: "Validate the delegated artifact." },
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: validatorAgentId,
      title: "Research mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: validatorIssueId,
      companyId,
      missionId,
      identifier: "PAP-QA",
      title: "[QA] Validate artifact before delivery",
      status: "todo",
      assigneeAgentId: validatorAgentId,
      originKind: "workflow_execution",
    });

    executeSpy.mockImplementation(async ({ onLog }) => {
      await onLog("stdout", "Claim: Shopify integration - Need to verify\nVerdict: PASS\n");
      return {
        ...successfulAdapterResult(),
        resultJson: {
          result:
            "**Validation Complete: PASS**\n\nShopify integration - Need to verify.\n\n**Verdict: PASS** — caveat is documented and does not require changes.",
        },
      };
    });

    const heartbeat = heartbeatService(db);
    const run = await heartbeat.invoke(
      validatorAgentId,
      "assignment",
      { taskKey: `issue:${validatorIssueId}`, issueId: validatorIssueId, missionId },
      "system",
      { actorType: "system", actorId: "test-suite" },
    );

    const finalized = await waitForRunTerminal(heartbeat, run!.id);
    expect(finalized.status).toBe("succeeded");

    const updatedIssue = await waitForIssueStatus(
      db,
      validatorIssueId,
      (issue) => issue.status === "done" && issue.executionRunId === null,
    );
    expect(updatedIssue.status).toBe("done");

    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, validatorIssueId));
    expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);
  });

  it("does not apply the REQUEST_CHANGES validation gate to mission owner control issues", async () => {
    const db = getDb();
    for (const [index, originKind] of (
      ["mission_main_executor_plan", "mission_main_executor_oversight", "mission_main_executor_unblock"] as const
    ).entries()) {
      const companyId = randomUUID();
      const ownerAgentId = randomUUID();
      const missionId = randomUUID();
      const sourceIssueId = randomUUID();
      const ownerIssueId = randomUUID();

      await db.insert(companies).values({
        id: companyId,
        name: `Paperclip ${originKind}`,
        issuePrefix: `PC${index}`,
        requireBoardApprovalForNewAgents: false,
      });
      await db.insert(agents).values({
        id: ownerAgentId,
        companyId,
        name: "Research Director",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: { promptTemplate: "Plan and coordinate the mission." },
        runtimeConfig: {},
        permissions: {},
      });
      await db.insert(missions).values({
        id: missionId,
        companyId,
        ownerAgentId,
        title: "Research mission",
        status: "active",
      });
      await db.insert(issues).values({
        id: sourceIssueId,
        companyId,
        missionId,
        identifier: `PC${index}-SOURCE`,
        title: "Source issue awaiting owner action",
        status: "blocked",
        assigneeAgentId: ownerAgentId,
        originKind: "research_director_plan_child",
      });
      await db.insert(issues).values({
        id: ownerIssueId,
        companyId,
        missionId,
        identifier: originKind === "mission_main_executor_plan" ? `PC${index}-PLAN` : `PC${index}-UNBLOCK`,
        title: originKind === "mission_main_executor_plan"
          ? "[Plan] Research mission"
          : originKind === "mission_main_executor_oversight"
            ? "[Oversight] Research mission"
            : "[Unblock] PAP-SOURCE: Source issue awaiting owner action",
        description: "Mission owner control issue that may mention validation outcomes while giving instructions.",
        status: "todo",
        assigneeAgentId: ownerAgentId,
        originKind,
        originId: originKind === "mission_main_executor_unblock" ? sourceIssueId : null,
      });

      executeSpy.mockImplementationOnce(async ({ onLog }) => {
        await onLog("stdout", "Owner action complete. Downstream QA may later return PASS or REQUEST_CHANGES.\n");
        await db
          .update(issues)
          .set({ status: "done", completedAt: new Date(), updatedAt: new Date() })
          .where(eq(issues.id, ownerIssueId));
        return {
          ...successfulAdapterResult(),
          resultJson: {
            result: "Mission owner action complete. Allowed downstream validator outcomes include PASS or REQUEST_CHANGES.",
          },
        };
      });

      const heartbeat = heartbeatService(db);
      const run = await heartbeat.invoke(
        ownerAgentId,
        "assignment",
        { taskKey: `issue:${ownerIssueId}`, issueId: ownerIssueId, missionId },
        "system",
        { actorType: "system", actorId: "test-suite" },
      );

      const finalized = await waitForRunTerminal(heartbeat, run!.id);
      expect(finalized.status).toBe("succeeded");

      const updatedIssue = await waitForIssueStatus(db, ownerIssueId, (issue) => issue.status === "done");
      expect(updatedIssue.status).toBe("done");

      const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, ownerIssueId));
      expect(comments.some((comment) => comment.body.includes("Mission validation gate: REQUEST_CHANGES"))).toBe(false);

      const issueActivity = await db.select().from(activityLog).where(eq(activityLog.entityId, ownerIssueId));
      expect(issueActivity.some((entry) => entry.action === "issue.validation_request_changes_auto_blocked")).toBe(false);

      const nestedOwnerActions = await db.select().from(issues).where(eq(issues.originId, ownerIssueId));
      expect(nestedOwnerActions.some((issue) => issue.originKind === "mission_main_executor_unblock")).toBe(false);
    }
  });
}
