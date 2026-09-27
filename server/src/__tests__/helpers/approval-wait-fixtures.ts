import { randomUUID } from "node:crypto";
import {
  agentWakeupRequests,
  agents,
  approvals,
  companies,
  heartbeatRuns,
  issueApprovals,
  issues,
  operatorDecisions,
} from "@paperclipai/db";

// [approval-waiting marker] 테스트 공용 픽스처 — pending operator_decisions / 미결 approvals
// 시드와 마커 판정 대상 런/웨이크업 시드를 제공한다.
export const APPROVAL_WAIT_OLD_DATE = new Date("2026-09-01T00:00:00.000Z");

export const APPROVAL_WAIT_MINIMAL_DEFINITION = {
  options: [],
  actions: [{ id: "ok", label: "OK", outcome: "submit", tone: "primary", requiresSelection: false }],
  selection: null,
  comment: { mode: "disabled", label: null, placeholder: null, maxLength: 0 },
  approvedScope: [],
  forbiddenScope: [],
} as const;

type Db = ReturnType<typeof import("@paperclipai/db").createDb>;

export function approvalWaitFixtures(db: Db) {
  async function seedBase(input?: { issueStatus?: string }) {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Approval Wait Co",
      issuePrefix: `AW${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Approval Wait Agent",
      role: "engineer",
      status: "paused",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Marker target issue",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      createdAt: APPROVAL_WAIT_OLD_DATE,
      updatedAt: APPROVAL_WAIT_OLD_DATE,
    });
    return { companyId, agentId, issueId };
  }

  async function seedPendingDecision(
    companyId: string,
    issueId: string,
    overrides?: { status?: string; sourceId?: string; workflowRunId?: string | null },
  ) {
    const [row] = await db
      .insert(operatorDecisions)
      .values({
        companyId,
        requestKey: `marker-${randomUUID()}`,
        requestHash: randomUUID(),
        status: overrides?.status ?? "pending",
        priority: "medium",
        interactionType: "action",
        title: "Marker decision",
        description: "",
        sourceType: "issue",
        sourceId: overrides?.sourceId ?? `issue:${issueId}`,
        sourceContext: {
          missionId: null,
          workflowId: null,
          workflowRunId: overrides?.workflowRunId ?? null,
          artifactRefs: [],
        },
        issueId,
        definition: APPROVAL_WAIT_MINIMAL_DEFINITION,
        continuationMode: "none",
      })
      .returning({ id: operatorDecisions.id });
    return row.id;
  }

  async function seedPendingApproval(companyId: string, issueId: string, status = "pending") {
    const [approval] = await db
      .insert(approvals)
      .values({ companyId, type: "custom", status, payload: {} })
      .returning({ id: approvals.id });
    await db.insert(issueApprovals).values({ companyId, issueId, approvalId: approval.id });
    return approval.id;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    status: "queued" | "running";
    withRunRow?: boolean;
  }) {
    const runId = randomUUID();
    const wakeupId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupId,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: { issueId: input.issueId },
      issueId: input.issueId,
      status: "queued",
      createdAt: APPROVAL_WAIT_OLD_DATE,
      requestedAt: APPROVAL_WAIT_OLD_DATE,
      ...(input.withRunRow === false ? {} : { runId }),
    });
    if (input.withRunRow === false) return { runId: null, wakeupId };
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: input.status,
      wakeupRequestId: wakeupId,
      contextSnapshot: { issueId: input.issueId },
      issueId: input.issueId,
      createdAt: APPROVAL_WAIT_OLD_DATE,
      updatedAt: APPROVAL_WAIT_OLD_DATE,
      startedAt: input.status === "running" ? APPROVAL_WAIT_OLD_DATE : null,
    });
    return { runId, wakeupId };
  }

  return { seedBase, seedPendingDecision, seedPendingApproval, seedRun };
}
