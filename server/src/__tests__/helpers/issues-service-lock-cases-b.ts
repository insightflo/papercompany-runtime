// issueService cases moved out of issues-service.test.ts (T16d, file <=1000 lines).
// Slice: downstream ordering + mission child burst-limit cases 5-15.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { expect, it, beforeAll } from "vitest";
import { agents, companies, createDb, issueWorkProducts, issues, missions } from "@paperclipai/db";
import { issueService } from "../../services/issues.ts";

export function registerIssuesServiceLockCasesB(deps: {
  getDb: () => ReturnType<typeof createDb>;
  getSvc: () => ReturnType<typeof issueService>;
}) {
  const { getDb, getSvc } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  beforeAll(() => {
    db = getDb();
    svc = getSvc();
  });

  it("rejects mission-owner planned downstream child issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const sourceAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sourceAgentId,
        companyId,
        name: "Source Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId,
      originKind: "research_director_plan",
      title: "[Dossier-A] Source dossiers for candidates",
      status: "in_progress",
      priority: "medium",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research_director_plan",
        title: "[Validation] Independent QA of evidence, claims, and HTML file",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    const sourceIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: sourceAgentId,
      originKind: "research_director_plan",
      title: "[Dossier-A] Source dossiers for candidates",
      status: "todo",
      priority: "medium",
    });
    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: assigneeAgentId,
        title: "[RES-458][QA] Independent URL/status and claim-evidence check",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    await expect(
      svc.create(companyId, {
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: assigneeAgentId,
        title: "[Synthesis] HTML report compilation",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
    const agentSourceChildIssue = await svc.create(companyId, {
      parentId: parentIssueId,
      assigneeAgentId: sourceAgentId,
      createdByAgentId: sourceAgentId,
      title: "[RES-458][Source] Direct URL harvest",
      status: "backlog",
      priority: "medium",
    });

    expect(sourceIssue.status).toBe("todo");
    expect(agentSourceChildIssue.status).toBe("todo");
  });

  it("rejects hyphenated research director downstream issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Synthesis Editor",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research-director-plan",
        title: "Synthesis + HTML authoring: verified packets only",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research-director-plan",
        title: "[Source] Evidence matrix and HTML shell draft",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("rejects mission owner plan child downstream issues before upstream artifacts", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        originKind: "research_director_plan_child",
        title: "[Validation Gate] HTML file independent verification",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("allows mission downstream child creation after a sibling upstream workProduct exists", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const sourceAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: sourceAgentId,
        companyId,
        name: "Source Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "Report Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: parentIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_oversight",
        title: "[OVERSIGHT] Workflow parent",
        status: "in_progress",
        priority: "medium",
      },
      {
        id: sourceIssueId,
        companyId,
        missionId,
        parentId: parentIssueId,
        assigneeAgentId: sourceAgentId,
        originKind: "manual",
        title: "[Source] Evidence packet",
        status: "done",
        priority: "medium",
      },
    ]);
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId: sourceIssueId,
      type: "document",
      provider: "local_file",
      title: "evidence.md",
      status: "ready_for_review",
      reviewState: "needs_board_review",
      isPrimary: true,
      metadata: { path: "/tmp/evidence.md" },
    });

    const downstream = await svc.create(companyId, {
      parentId: parentIssueId,
      assigneeAgentId: qaAgentId,
      createdByAgentId: ownerAgentId,
      title: "[Validation] Independent QA of evidence and note",
      status: "todo",
      priority: "medium",
    });

    expect(downstream.status).toBe("todo");
    expect(downstream.missionId).toBe(missionId);
    expect(downstream.parentId).toBe(parentIssueId);
  });

  it("allows only native DAG/system materialization for mission-level ACTION/QA/OVERSIGHT sibling issues", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const qaAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Source Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: qaAgentId,
        companyId,
        name: "QA Validator",
        role: "qa",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "planning",
    });
    await db.insert(issues).values({
      id: planIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[PLAN] Mission work structure",
      status: "in_progress",
      priority: "medium",
    });

    await expect(svc.create(companyId, {
      missionId,
      assigneeAgentId: workerAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_action",
      title: "[ACTION] Source dossiers for candidates",
      status: "todo",
      priority: "medium",
    })).rejects.toThrow(/server-native DAG/i);
    await expect(svc.create(companyId, {
      missionId,
      assigneeAgentId: qaAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_qa",
      title: "[QA] Independent evidence and claim verification",
      status: "todo",
      priority: "high",
    })).rejects.toThrow(/server-native DAG/i);
    await expect(svc.create(companyId, {
      missionId,
      assigneeAgentId: ownerAgentId,
      createdByAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Failure/retry/escalation decisions",
      status: "todo",
      priority: "medium",
    })).rejects.toThrow(/server-native DAG/i);

    const actionIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: workerAgentId,
      originKind: "workflow_execution",
      title: "[ACTION] Source dossiers for candidates",
      status: "todo",
      priority: "medium",
    });
    const qaIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: qaAgentId,
      originKind: "workflow_execution",
      title: "[QA] Independent evidence and claim verification",
      status: "todo",
      priority: "high",
    });
    const oversightIssue = await svc.create(companyId, {
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "workflow_execution",
      title: "[OVERSIGHT] Failure/retry/escalation decisions",
      status: "todo",
      priority: "medium",
    });

    expect(actionIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "action" }));
    expect(qaIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "qa" }));
    expect(oversightIssue).toEqual(expect.objectContaining({ parentId: null, issueGroup: "oversight" }));

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: planIssueId,
        assigneeAgentId: qaAgentId,
        createdByAgentId: ownerAgentId,
        originKind: "mission_qa",
        title: "[QA] Plan-child validation should not be allowed",
        status: "todo",
        priority: "high",
      }),
    ).rejects.toThrow("Mission downstream issue creation is not allowed");
  });

  it("rejects nested mission child issues created by workers", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
    const missionId = randomUUID();
    const planIssueId = randomUUID();
    const sourceIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: workerAgentId,
        companyId,
        name: "Research Worker",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values([
      {
        id: planIssueId,
        companyId,
        missionId,
        assigneeAgentId: ownerAgentId,
        originKind: "mission_main_executor_plan",
        title: "[Plan] Mission",
        status: "done",
        priority: "medium",
      },
      {
        id: sourceIssueId,
        companyId,
        missionId,
        parentId: planIssueId,
        assigneeAgentId: workerAgentId,
        originKind: "manual",
        title: "[Source] First wave packet",
        status: "in_progress",
        priority: "medium",
      },
    ]);

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: sourceIssueId,
        assigneeAgentId: workerAgentId,
        createdByAgentId: workerAgentId,
        title: "[Source Audit] Worker-created subpacket",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission nested child issue creation is not allowed");
  });

  it("limits system-created mission child issue bursts without createdByAgentId", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[Plan] Mission",
      status: "in_progress",
      priority: "medium",
    });

    for (let index = 0; index < 6; index += 1) {
      await svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        title: `[Source] System packet ${index + 1}`,
        status: "todo",
        priority: "medium",
      });
    }

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        title: "[Source] System packet 7",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission child issue burst limit exceeded");
  });

  it("limits agent-created mission child issue bursts per parent", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const assigneeAgentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values([
      {
        id: ownerAgentId,
        companyId,
        name: "Mission Owner",
        role: "owner",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
      {
        id: assigneeAgentId,
        companyId,
        name: "Researcher",
        role: "worker",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {},
        permissions: {},
      },
    ]);
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_plan",
      title: "[Plan] Mission",
      status: "in_progress",
      priority: "medium",
    });

    for (let index = 0; index < 6; index += 1) {
      const issue = await svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: ownerAgentId,
        title: `[Source] Packet ${index + 1}`,
        status: "todo",
        priority: "medium",
      });
      expect(issue.status).toBe("todo");
    }

    await expect(
      svc.create(companyId, {
        missionId,
        parentId: parentIssueId,
        assigneeAgentId,
        createdByAgentId: ownerAgentId,
        title: "[Source] Packet 7",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Mission child issue burst limit exceeded");
  });
}
