import { describe, expect, it } from "vitest";
import type { Agent, Company, Issue } from "@paperclipai/plugin-sdk";
import { createTestHarness } from "@paperclipai/plugin-sdk/testing";
import manifest from "../../../../papercompany-plugins/packages/service-request-bridge/src/manifest.js";
import worker from "../../../../papercompany-plugins/packages/service-request-bridge/src/worker.js";
import {
  BRIDGE_DIRECTIONS,
  ENTITY_TYPES,
} from "../../../../papercompany-plugins/packages/service-request-bridge/src/constants.js";
import { upsertBridgePair } from "../../../../papercompany-plugins/packages/service-request-bridge/src/store.js";

function makeCompany(id: string, name: string, issuePrefix: string): Company {
  const now = new Date("2026-04-09T00:00:00.000Z");
  return {
    id,
    name,
    description: null,
    status: "active",
    pauseReason: null,
    pausedAt: null,
    issuePrefix,
    issueCounter: 0,
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false,
    brandColor: null,
    logoAssetId: null,
    logoUrl: null,
    createdAt: now,
    updatedAt: now,
  };
}

function makeIssue(input: {
  id: string;
  companyId: string;
  title: string;
  status: Issue["status"];
  identifier: string;
  assigneeAgentId?: string | null;
}): Issue {
  const now = new Date("2026-04-09T00:00:00.000Z");
  return {
    id: input.id,
    companyId: input.companyId,
    projectId: null,
    projectWorkspaceId: null,
    goalId: null,
    parentId: null,
    title: input.title,
    description: "Need maintenance support",
    status: input.status,
    priority: "medium",
    assigneeAgentId: input.assigneeAgentId ?? null,
    assigneeUserId: null,
    checkoutRunId: null,
    executionRunId: null,
    executionAgentNameKey: null,
    executionLockedAt: null,
    createdByAgentId: null,
    createdByUserId: null,
    issueNumber: 1,
    identifier: input.identifier,
    originKind: "manual",
    originId: null,
    originRunId: null,
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
    createdAt: now,
    updatedAt: now,
  };
}

function makeAgent(input: {
  id: string;
  companyId: string;
  role: Agent["role"];
  name: string;
}): Agent {
  const now = new Date("2026-04-09T00:00:00.000Z");
  return {
    id: input.id,
    companyId: input.companyId,
    name: input.name,
    urlKey: input.name.toLowerCase(),
    role: input.role,
    title: input.role === "ceo" ? "CEO" : null,
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: input.role === "ceo" },
    lastHeartbeatAt: null,
    defaultParentIssueId: null,
    metadata: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe("service-request-bridge worker", () => {
  it("creates the bridge pair before blocking the source issue", async () => {
    const harness = createTestHarness({
      manifest,
      config: {
        providerCompanyId: "company-provider",
        requesterLabelNames: [],
        requesterTitlePrefixes: ["maintenance"],
        autoCreateMirrorIssue: true,
      },
    });

    harness.seed({
      companies: [
        makeCompany("company-source", "Source Co", "SRC"),
        makeCompany("company-provider", "Provider Co", "PRV"),
      ],
      issues: [
        makeIssue({
          id: "issue-source",
          companyId: "company-source",
          title: "[maintenance] Maintenance request",
          status: "todo",
          identifier: "SRC-1",
        }),
      ],
      agents: [
        makeAgent({ id: "agent-provider-ceo", companyId: "company-provider", role: "ceo", name: "Provider CEO" }),
      ],
    });

    await worker.definition.setup(harness.ctx);

    let observedBlockedUpdate = false;
    const originalUpdate = harness.ctx.issues.update.bind(harness.ctx.issues);
    harness.ctx.issues.update = async (issueId, patch, companyId) => {
      if (issueId === "issue-source" && patch.status === "blocked") {
        observedBlockedUpdate = true;
        const bridgeLinks = await harness.ctx.entities.list({
          entityType: ENTITY_TYPES.bridgeLink,
          scopeKind: "company",
          scopeId: "company-source",
        });
        expect(bridgeLinks).toHaveLength(1);
        expect(bridgeLinks[0]?.data).toMatchObject({
          localIssueId: "issue-source",
          remoteCompanyId: "company-provider",
        });
      }
      return await originalUpdate(issueId, patch, companyId);
    };

    await harness.emit("issue.created", {
      companyId: "company-source",
      issueId: "issue-source",
      title: "[maintenance] Maintenance request",
      description: "Need maintenance support",
    }, {
      entityId: "issue-source",
      entityType: "issue",
      eventId: "evt-created-1",
      companyId: "company-source",
    });

    const providerIssues = await harness.ctx.issues.list({ companyId: "company-provider", limit: 50, offset: 0 });
    const mirrorIssueId = providerIssues[0]?.id;

    expect(observedBlockedUpdate).toBe(true);
    expect(providerIssues).toHaveLength(1);
    expect(providerIssues[0]).toMatchObject({
      status: "todo",
      assigneeAgentId: "agent-provider-ceo",
    });

    if (!mirrorIssueId) {
      throw new Error("Expected mirror issue to be created");
    }

    await harness.emit("issue.updated", {
      companyId: "company-source",
      issueId: "issue-source",
      status: "blocked",
    }, {
      entityId: "issue-source",
      entityType: "issue",
      eventId: "evt-updated-1",
      companyId: "company-source",
    });

    const mirrorIssue = await harness.ctx.issues.get(mirrorIssueId, "company-provider");
    expect(mirrorIssue?.status).toBe("blocked");

    const syncStamps = await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.syncStamp,
      scopeKind: "company",
      scopeId: "company-provider",
    });
    expect(syncStamps).toHaveLength(1);
    expect(syncStamps[0]?.data).toMatchObject({
      localIssueId: mirrorIssueId,
      remoteCompanyId: "company-source",
      remoteIssueId: "issue-source",
      status: "blocked",
    });
  });

  it("propagates linked status updates to the mirror issue and records a sync stamp", async () => {
    const harness = createTestHarness({ manifest });

    harness.seed({
      companies: [
        makeCompany("company-source", "Source Co", "SRC"),
        makeCompany("company-provider", "Provider Co", "PRV"),
      ],
      issues: [
        makeIssue({
          id: "issue-source",
          companyId: "company-source",
          title: "Maintenance request",
          status: "todo",
          identifier: "SRC-1",
        }),
        makeIssue({
          id: "issue-mirror",
          companyId: "company-provider",
          title: "[유지보수] Maintenance request",
          status: "todo",
          identifier: "PRV-1",
        }),
      ],
    });

    await worker.definition.setup(harness.ctx);

    await upsertBridgePair(harness.ctx, {
      localCompanyId: "company-source",
      localIssueId: "issue-source",
      remoteCompanyId: "company-provider",
      remoteIssueId: "issue-mirror",
      direction: BRIDGE_DIRECTIONS.twoWay,
      createdBy: "test",
    });

    await harness.emit("issue.updated", {
      companyId: "company-source",
      issueId: "issue-source",
      status: "blocked",
    }, {
      entityId: "issue-source",
      entityType: "issue",
      eventId: "evt-updated-1",
      companyId: "company-source",
    });

    const mirrorIssue = await harness.ctx.issues.get("issue-mirror", "company-provider");
    expect(mirrorIssue?.status).toBe("blocked");

    const syncStamps = await harness.ctx.entities.list({
      entityType: ENTITY_TYPES.syncStamp,
      scopeKind: "company",
      scopeId: "company-provider",
    });
    expect(syncStamps).toHaveLength(1);
    expect(syncStamps[0]?.data).toMatchObject({
      localIssueId: "issue-mirror",
      remoteCompanyId: "company-source",
      remoteIssueId: "issue-source",
      status: "blocked",
    });
  });
});
