// issueService cases moved out of issues-service.test.ts (T16d, file <=1000 lines).
// Slice: lock remediation / manual-onboarding delivery cases 1-4.
// Case bodies are moved verbatim: the describe-scoped db connection, service handle and fixture
// helpers are injected by the caller so the suite lifecycle stays in one place.
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it, beforeAll } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueWorkProducts, issues, missions } from "@paperclipai/db";
import { issueService } from "../../services/issues.ts";
import { setPublicUrlReadbackFetcher } from "../../services/public-url-readback.ts";

export function registerIssuesServiceLockCasesA(deps: {
  getDb: () => ReturnType<typeof createDb>;
  getSvc: () => ReturnType<typeof issueService>;
  createManualOnboardingActionFixture: () => Promise<{ issueId: string; productUrl: string }>;
}) {
  const { getDb, getSvc, createManualOnboardingActionFixture } = deps;

  // Late-bound: the caller assigns these describe-scoped values in its own beforeAll, which
  // is registered before this hook, so every case sees the live connection and service.
  let db!: ReturnType<typeof createDb>;
  let svc!: ReturnType<typeof issueService>;
  beforeAll(() => {
    db = getDb();
    svc = getSvc();
  });

  it("allows workflow ACTION completion without running delivery readback", async () => {
    const { issueId, productUrl } = await createManualOnboardingActionFixture();
    let readbackUrl = "";
    setPublicUrlReadbackFetcher(async (url) => {
      readbackUrl = url;
      return {
        ok: true,
        status: 200,
        text: "<!doctype html><html><head><title>온보딩 라이브러리</title></head><body>hub</body></html>",
      };
    });

    const updated = await svc.update(issueId, { status: "done" });

    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(updated).toEqual(expect.objectContaining({ id: issueId, status: "done" }));
    expect(readbackUrl).toBe("");
    expect(productUrl).toContain("manual-onboarding.pages.dev");
    expect(issue?.status).toBe("done");
    expect(issue?.completedAt).toBeInstanceOf(Date);
  });

  it("allows workflow ACTION completion with delivery criteria and only a local file workProduct", async () => {
    const issueId = randomUUID();
    const companyId = randomUUID();
    const missionId = randomUUID();
    const ownerAgentId = randomUUID();
    const workerAgentId = randomUUID();
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
      title: "orca beginner manual",
      status: "active",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      assigneeAgentId: workerAgentId,
      originKind: "workflow_execution",
      title: "[ACTION] Synthesize Korean beginner HTML manual for orca",
      description: "Delivery Verification: final public URL readback will be checked by a downstream QA step.",
      status: "todo",
      priority: "medium",
    });
    await db.insert(issueWorkProducts).values({
      companyId,
      issueId,
      type: "document",
      provider: "local_file",
      title: "orca_beginner_manual_ko.html",
      externalId: "/srv/papercompany/projects/research-company/produced_work/orca_beginner_manual_ko.html",
      status: "active",
      isPrimary: true,
      metadata: {
        path: "/srv/papercompany/projects/research-company/produced_work/orca_beginner_manual_ko.html",
        registeredVia: "workflow_api",
      },
    });
    setPublicUrlReadbackFetcher(async (url) => {
      throw new Error(`delivery readback should not run during ACTION closeout: ${url}`);
    });

    const updated = await svc.update(issueId, { status: "done" });

    expect(updated).toEqual(expect.objectContaining({ id: issueId, status: "done" }));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect(issue?.completedAt).toBeInstanceOf(Date);
  });

  it("repairs malformed same-run locks when executionRunId already matches the actor run", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "on_demand",
      status: "running",
      contextSnapshot: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Malformed same-run lock",
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: runId,
      executionLockedAt: new Date(),
    });

    const ownership = await svc.assertCheckoutOwner(issueId, agentId, runId);

    expect(ownership).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      adoptedFromRunId: null,
      repairedMalformedExecutionLock: true,
    }));

    const repaired = await db
      .select({
        checkoutRunId: issues.checkoutRunId,
        executionRunId: issues.executionRunId,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);

    expect(repaired).toEqual({
      checkoutRunId: runId,
      executionRunId: runId,
    });
  });

  it("adopts stale terminal execution locks with no checkout lock during checkout", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const staleRunId = randomUUID();
    const nextRunId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Research Worker",
      role: "researcher",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values([
      {
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "targeted_wakeup",
        status: "cancelled",
        contextSnapshot: {},
        finishedAt: new Date(),
      },
      {
        id: nextRunId,
        companyId,
        agentId,
        invocationSource: "targeted_wakeup",
        status: "running",
        contextSnapshot: {},
      },
    ]);
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Issue with stale execution lock only",
      status: "todo",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: null,
      executionRunId: staleRunId,
      executionLockedAt: new Date(),
    });

    const checkedOut = await svc.checkout(issueId, agentId, ["todo"], nextRunId);

    expect(checkedOut).toEqual(expect.objectContaining({
      id: issueId,
      status: "in_progress",
      assigneeAgentId: agentId,
      checkoutRunId: nextRunId,
      executionRunId: nextRunId,
    }));
  });

  it("clears checkout and execution locks when an active issue is blocked by update", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "QA Agent",
      role: "qa",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "targeted_wakeup",
      status: "running",
      contextSnapshot: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Active QA gate",
      status: "in_progress",
      priority: "medium",
      assigneeAgentId: agentId,
      checkoutRunId: runId,
      executionRunId: runId,
      executionAgentNameKey: "qa-agent",
      executionLockedAt: new Date(),
    });

    const updated = await svc.update(issueId, { status: "blocked" });

    expect(updated).toEqual(
      expect.objectContaining({
        id: issueId,
        status: "blocked",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      }),
    );
  });

  it("rejects missing parent issues before insert", async () => {
    const companyId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await expect(
      svc.create(companyId, {
        title: "Child with stale parent",
        status: "todo",
        priority: "medium",
        parentId: randomUUID(),
      }),
    ).rejects.toThrow("Parent issue not found");
  });

  it("inherits the parent mission when creating a sub-issue without missionId", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const missionId = randomUUID();
    const parentIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId: agentId,
      title: "Mission-scoped execution",
      status: "active",
    });
    await db.insert(issues).values({
      id: parentIssueId,
      companyId,
      missionId,
      title: "Mission issue",
      status: "todo",
      priority: "medium",
    });

    const child = await svc.create(companyId, {
      parentId: parentIssueId,
      title: "Mission child issue",
      status: "todo",
      priority: "medium",
    });

    expect(child).toEqual(expect.objectContaining({
      parentId: parentIssueId,
      missionId,
    }));
  });

  it("rejects creating issues for terminal missions", async () => {
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
        name: "Worker",
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
      title: "Cancelled mission",
      status: "cancelled",
    });

    await expect(
      svc.create(companyId, {
        missionId,
        assigneeAgentId,
        title: "Late recovery source task",
        status: "todo",
        priority: "medium",
      }),
    ).rejects.toThrow("Cannot create issues for a completed or cancelled mission");
  });

  it("rejects reopening an issue inside a terminal mission", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const issueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Cancelled mission",
      status: "cancelled",
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      missionId,
      title: "Cancelled mission issue",
      status: "cancelled",
      priority: "medium",
    });

    await expect(svc.update(issueId, { status: "todo" })).rejects.toThrow(
      "Cannot reopen or execute issues for a completed or cancelled mission",
    );
  });

  it("rejects completing mission oversight while the mission is still active", async () => {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();
    const oversightIssueId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
      role: "owner",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(missions).values({
      id: missionId,
      companyId,
      ownerAgentId,
      title: "Active mission",
      status: "active",
    });
    await db.insert(issues).values({
      id: oversightIssueId,
      companyId,
      missionId,
      assigneeAgentId: ownerAgentId,
      originKind: "mission_main_executor_oversight",
      title: "[OVERSIGHT] Active mission",
      status: "todo",
      priority: "medium",
    });

    await expect(svc.update(oversightIssueId, { status: "done" })).rejects.toThrow(
      /Cannot complete mission oversight while mission .* is active/,
    );

    const [oversight] = await db.select().from(issues).where(eq(issues.id, oversightIssueId));
    expect(oversight?.status).toBe("todo");
    expect(oversight?.completedAt).toBeNull();
  });
}
