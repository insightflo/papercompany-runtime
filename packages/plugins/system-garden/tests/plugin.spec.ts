import { describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { IssueComment } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../src/manifest.js";
import { buildMissionIssueGraph } from "../src/issue-graph.js";
import plugin from "../src/worker.js";

const COMPANY_ID = "company-garden";
type SeedAgent = NonNullable<Parameters<ReturnType<typeof createTestHarness>["seed"]>[0]["agents"]>[number];
type SeedIssue = NonNullable<Parameters<ReturnType<typeof createTestHarness>["seed"]>[0]["issues"]>[number];

function makeAgent(overrides: Partial<SeedAgent>): SeedAgent {
  return {
    id: `agent-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    name: "Untitled agent",
    urlKey: "untitled-agent",
    role: "general",
    title: null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "process",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    defaultParentIssueId: null,
    metadata: null,
    createdAt: new Date("2026-03-23T00:00:00.000Z"),
    updatedAt: new Date("2026-03-23T00:00:00.000Z"),
    ...overrides,
  } satisfies SeedAgent;
}

function makeIssue(overrides: Partial<SeedIssue>): SeedIssue {
  return {
    id: `issue-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: "Untitled issue",
    description: null,
    status: "todo",
    priority: "medium",
    assigneeAgentId: null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: "local-board",
    issueNumber: null,
    identifier: null,
    requestDepth: 0,
    billingCode: null,
    assigneeAdapterOverrides: null,
    executionWorkspaceId: null,
    executionWorkspacePreference: null,
    executionWorkspaceSettings: null,
    startedAt: null,
    completedAt: null,
    cancelledAt: null,
    hiddenAt: null,
    createdAt: new Date("2026-03-20T00:00:00.000Z"),
    updatedAt: new Date("2026-03-22T00:00:00.000Z"),
    ...overrides,
  } satisfies SeedIssue;
}

function makeIssueComment(overrides: Partial<IssueComment>): IssueComment {
  return {
    id: `comment-${Math.random().toString(36).slice(2)}`,
    companyId: COMPANY_ID,
    issueId: "issue-unknown",
    authorAgentId: null,
    authorUserId: null,
    body: "Untitled comment",
    createdAt: new Date("2026-03-23T01:00:00.000Z"),
    updatedAt: new Date("2026-03-23T01:00:00.000Z"),
    ...overrides,
  };
}

describe("system-garden plugin", () => {
  it("builds a graph, health cards, and questions from seeded agents and issues", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const ceo = makeAgent({ id: "agent-ceo", name: "CEO", role: "ceo", urlKey: "ceo" });
    const cto = makeAgent({ id: "agent-cto", name: "CTO", role: "cto", urlKey: "cto", reportsTo: ceo.id });
    const engineer = makeAgent({
      id: "agent-eng",
      name: "Engineer",
      role: "engineer",
      urlKey: "engineer",
      reportsTo: cto.id,
      status: "running",
    });

    harness.seed({
      agents: [ceo, cto, engineer],
      issues: [
        makeIssue({
          id: "issue-done",
          identifier: "GAR-1",
          title: "배송",
          status: "done",
          completedAt: new Date("2026-03-23T01:00:00.000Z"),
          assigneeAgentId: engineer.id,
        }),
        makeIssue({
          id: "issue-review",
          identifier: "GAR-2",
          title: "검수 대기",
          status: "in_review",
          assigneeAgentId: engineer.id,
        }),
        makeIssue({
          id: "issue-open",
          identifier: "GAR-3",
          title: "남은 작업",
          status: "todo",
          assigneeAgentId: cto.id,
          updatedAt: new Date("2026-03-15T00:00:00.000Z"),
        }),
      ],
    });

    const data = await harness.getData<import("../src/worker.js").GardenSnapshot>("system-garden-snapshot", {
      companyId: COMPANY_ID,
    });

    expect(data.meta.agentCount).toBe(3);
    expect(data.meta.issueCount).toBe(3);
    expect(data.graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([ceo.id, cto.id, engineer.id]));
    expect(data.graph.edges).toEqual(expect.arrayContaining([
      { source: cto.id, target: ceo.id, label: "reportsTo" },
      { source: engineer.id, target: cto.id, label: "reportsTo" },
    ]));
    expect(data.cards.map((card) => card.name)).toEqual(expect.arrayContaining(["전체 가동률", "CEO", "CTO", "Engineer"]));
    expect(data.questions.length).toBeGreaterThan(0);
  });

  it("returns recent issues for the selected agent detail view", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const manager = makeAgent({ id: "agent-manager", name: "Manager", role: "general", urlKey: "manager" });

    harness.seed({
      agents: [manager],
      issues: [
        makeIssue({
          id: "issue-old",
          identifier: "GAR-11",
          title: "오래된 작업",
          assigneeAgentId: manager.id,
          updatedAt: new Date("2026-03-18T00:00:00.000Z"),
        }),
        makeIssue({
          id: "issue-new",
          identifier: "GAR-12",
          title: "최근 작업",
          assigneeAgentId: manager.id,
          updatedAt: new Date("2026-03-23T02:00:00.000Z"),
        }),
      ],
    });

    const detail = await harness.getData<import("../src/worker.js").AgentDetailSnapshot | null>("system-garden-agent-detail", {
      companyId: COMPANY_ID,
      agentId: manager.id,
    });

    expect(detail?.agentId).toBe(manager.id);
    expect(detail?.recentIssues.map((issue) => issue.identifier)).toEqual(["GAR-12", "GAR-11"]);
  });

  it("merges UA code knowledge graph nodes and edges into the agent graph", async () => {
    const harness = createTestHarness({ manifest });
    await plugin.definition.setup(harness.ctx);

    const engineer = makeAgent({ id: "agent-eng", name: "Engineer", role: "engineer", urlKey: "engineer" });
    harness.seed({ agents: [engineer], issues: [] });

    const tempDir = await mkdtemp(path.join(os.tmpdir(), "system-garden-kg-"));
    const kgPath = path.join(tempDir, "knowledge-graph.json");
    const previousEnv = process.env.SYSTEM_GARDEN_KG_PATH;
    process.env.SYSTEM_GARDEN_KG_PATH = kgPath;

    await writeFile(
      kgPath,
      JSON.stringify({
        nodes: [
          { id: "packages/plugins/system-garden/src/worker.ts", type: "file", label: "worker.ts", layer: "worker" },
          { id: "buildGardenSnapshot", type: "function", label: "buildGardenSnapshot", layer: "worker" },
        ],
        edges: [
          {
            source: "packages/plugins/system-garden/src/worker.ts",
            target: "buildGardenSnapshot",
            type: "contains",
          },
        ],
      }),
      "utf8",
    );

    try {
      const data = await harness.getData<import("../src/worker.js").GardenSnapshot>("system-garden-snapshot", {
        companyId: COMPANY_ID,
      });

      const codeNode = data.graph.nodes.find((node) => node.id === "code:buildGardenSnapshot");
      expect(codeNode).toBeTruthy();
      expect(codeNode?.kind).toBe("function");
      expect(data.graph.nodes.find((node) => node.id === "code:packages/plugins/system-garden/src/worker.ts")?.kind).toBe("module");
      expect(data.graph.edges).toEqual(expect.arrayContaining([
        {
          source: "code:packages/plugins/system-garden/src/worker.ts",
          target: "code:buildGardenSnapshot",
          label: "contains",
        },
      ]));
      expect(data.graph.nodes.map((node) => node.id)).toContain(engineer.id);
    } finally {
      if (previousEnv === undefined) delete process.env.SYSTEM_GARDEN_KG_PATH;
      else process.env.SYSTEM_GARDEN_KG_PATH = previousEnv;
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  it("derives mission board issue relations from titles, comments, parents, and reissue markers", async () => {
    const sherlock = makeAgent({ id: "agent-sherlock", name: "셜록", role: "general", urlKey: "sherlock" });
    const scrooge = makeAgent({ id: "agent-scrooge", name: "스크루지", role: "general", urlKey: "scrooge" });

    const original = makeIssue({
      id: "issue-original",
      identifier: "CMPA-248",
      title: "[유지보수] auto pipeline.py slides 단계 notebook create 400 에러",
      assigneeAgentId: sherlock.id,
      status: "todo",
    });
    const followUp = makeIssue({
      id: "issue-followup",
      identifier: "CMPA-249",
      title: "[경고] slides stage retry follow-up",
      assigneeAgentId: scrooge.id,
      status: "in_progress",
    });
    const reissue = makeIssue({
      id: "issue-reissue",
      identifier: "CMPA-250",
      title: "[유지보수] auto pipeline.py slides 단계 notebook create 400 에러 (CMPA-248 재이슈)",
      assigneeAgentId: scrooge.id,
      status: "in_review",
    });
    const child = makeIssue({
      id: "issue-child",
      identifier: "CMPA-251",
      title: "[지시] repair notebook create edge case",
      parentId: original.id,
      assigneeAgentId: sherlock.id,
      status: "todo",
    });

    const graph = await buildMissionIssueGraph({
      issues: [original, followUp, reissue, child],
      agentsById: new Map([
        [sherlock.id, { id: sherlock.id, name: sherlock.name }],
        [scrooge.id, { id: scrooge.id, name: scrooge.name }],
      ]),
      loadComments: async (issueId) => {
        if (issueId !== original.id) return [];
        return [
          makeIssueComment({
            issueId: original.id,
            body: "후속 대응 필요. CMPA-249 생성해서 follow-up으로 넘기자.",
          }),
        ];
      },
      maxDepth: 2,
    });

    expect(graph.seedIssueIds).toEqual(expect.arrayContaining([original.id, followUp.id, reissue.id, child.id]));
    expect(graph.graph.nodes.map((node) => node.id)).toEqual(expect.arrayContaining([
      original.id,
      followUp.id,
      reissue.id,
      child.id,
    ]));
    expect(graph.graph.edges).toEqual(expect.arrayContaining([
      { source: original.id, target: sherlock.id, label: "assignee" },
      { source: followUp.id, target: scrooge.id, label: "assignee" },
      { source: reissue.id, target: scrooge.id, label: "assignee" },
      { source: child.id, target: sherlock.id, label: "assignee" },
      { source: child.id, target: original.id, label: "parent" },
      { source: original.id, target: reissue.id, label: "reissue" },
      { source: original.id, target: followUp.id, label: "spawned_followup" },
    ]));
  });
});
