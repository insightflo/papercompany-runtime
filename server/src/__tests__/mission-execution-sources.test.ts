import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  missions,
  pluginEntities,
  plugins,
  workflowRuns,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  isTerminalFailureStatus,
  listMissionExecutionSourceSnapshots,
  mapNativeWorkflowRunToExecutionUnit,
  mapPluginWorkflowRunEntityToExecutionUnit,
  mapPluginWorkflowStepRunEntityToExecutionUnit,
  normalizeMissionExecutionStatus,
} from "../services/missions/mission-execution-sources.js";

describe("mission execution source helpers", () => {
  it.each([
    ["pending", "pending"],
    [" running ", "running"],
    ["in_progress", "running"],
    ["completed", "completed"],
    ["done", "completed"],
    ["succeeded", "completed"],
    ["success", "completed"],
    ["failed", "failed"],
    ["error", "failed"],
    ["aborted", "cancelled"],
    ["cancelled", "cancelled"],
    ["canceled", "cancelled"],
    ["timed-out", "timed_out"],
    ["timed_out", "timed_out"],
    ["timeout", "timed_out"],
    [null, "unknown"],
    [undefined, "unknown"],
    ["mystery", "unknown"],
  ] as const)("normalizes %s to %s", (value, expected) => {
    expect(normalizeMissionExecutionStatus(value)).toBe(expected);
  });

  it("detects terminal failure statuses", () => {
    expect(isTerminalFailureStatus("failed")).toBe(true);
    expect(isTerminalFailureStatus("cancelled")).toBe(true);
    expect(isTerminalFailureStatus("timed_out")).toBe(true);
    expect(isTerminalFailureStatus("pending")).toBe(false);
    expect(isTerminalFailureStatus("running")).toBe(false);
    expect(isTerminalFailureStatus("completed")).toBe(false);
    expect(isTerminalFailureStatus("unknown")).toBe(false);
  });

  it("maps a native workflow run into an execution unit", () => {
    const createdAt = new Date("2026-05-01T00:00:00.000Z");
    const startedAt = new Date("2026-05-01T00:01:00.000Z");

    const unit = mapNativeWorkflowRunToExecutionUnit({
      id: "native-run-1",
      workflowId: "workflow-1",
      companyId: "company-1",
      missionId: "mission-1",
      status: "in_progress",
      triggeredBy: "scheduler",
      startedAt,
      completedAt: null,
      createdAt,
      workflowName: "Native Daily Workflow",
    });

    expect(unit).toEqual(
      expect.objectContaining({
        id: "native-run-1",
        kind: "native_workflow_run",
        workflowId: "workflow-1",
        companyId: "company-1",
        missionId: "mission-1",
        workflowName: "Native Daily Workflow",
        status: "running",
        triggeredBy: "scheduler",
        startedAt,
        completedAt: null,
        createdAt,
        pluginId: null,
        entityId: "native-run-1",
        externalId: null,
        sourceRef: {
          type: "native_workflow_run",
          id: "native-run-1",
          workflowRunId: "native-run-1",
          stepId: null,
          issueId: null,
          pluginId: null,
          externalId: null,
        },
      }),
    );
  });

  it("maps a plugin workflow run entity and prefers data.status", () => {
    const startedAt = new Date("2026-05-02T00:00:00.000Z");
    const completedAt = new Date("2026-05-02T00:05:00.000Z");
    const createdAt = new Date("2026-05-02T00:00:00.000Z");
    const updatedAt = new Date("2026-05-02T00:05:00.000Z");

    const unit = mapPluginWorkflowRunEntityToExecutionUnit({
      id: "plugin-run-1",
      pluginId: "plugin-1",
      entityType: "workflow-run",
      scopeKind: "company",
      scopeId: "company-1",
      externalId: "ext-run-1",
      title: "Plugin Workflow Run",
      status: "running",
      data: {
        workflowId: "plugin-workflow-1",
        workflowName: "Plugin Workflow",
        companyId: "company-1",
        missionId: "mission-1",
        status: "timed-out",
        triggerSource: "schedule",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      createdAt,
      updatedAt,
    });

    expect(unit).toEqual(
      expect.objectContaining({
        id: "plugin-run-1",
        kind: "plugin_workflow_run",
        workflowId: "plugin-workflow-1",
        workflowName: "Plugin Workflow",
        companyId: "company-1",
        missionId: "mission-1",
        status: "timed_out",
        triggeredBy: "schedule",
        startedAt,
        completedAt,
        createdAt,
        pluginId: "plugin-1",
        entityId: "plugin-run-1",
        externalId: "ext-run-1",
        sourceRef: {
          type: "plugin_workflow_run",
          id: "plugin-run-1",
          workflowRunId: "plugin-run-1",
          stepId: null,
          issueId: null,
          pluginId: "plugin-1",
          externalId: "ext-run-1",
        },
      }),
    );
    expect(isTerminalFailureStatus(unit.status)).toBe(true);
  });

  it("maps a plugin workflow step entity even when issueId is null", () => {
    const startedAt = new Date("2026-05-03T00:00:00.000Z");
    const completedAt = new Date("2026-05-03T00:03:00.000Z");

    const unit = mapPluginWorkflowStepRunEntityToExecutionUnit({
      id: "plugin-step-1",
      pluginId: "plugin-1",
      entityType: "workflow-step-run",
      scopeKind: "company",
      scopeId: "company-1",
      externalId: "ext-step-1",
      title: "Fetch research",
      status: "running",
      data: {
        workflowRunId: "plugin-run-1",
        stepId: "step-fetch",
        issueId: null,
        status: "failed",
        startedAt: startedAt.toISOString(),
        completedAt: completedAt.toISOString(),
      },
      createdAt: new Date("2026-05-03T00:00:00.000Z"),
      updatedAt: completedAt,
    });

    expect(unit).toEqual(
      expect.objectContaining({
        id: "plugin-step-1",
        kind: "plugin_workflow_step_run",
        workflowRunId: "plugin-run-1",
        stepId: "step-fetch",
        issueId: null,
        workflowName: null,
        status: "failed",
        pluginId: "plugin-1",
        entityId: "plugin-step-1",
        externalId: "ext-step-1",
        sourceRef: {
          type: "plugin_workflow_step_run",
          id: "plugin-step-1",
          workflowRunId: "plugin-run-1",
          stepId: "step-fetch",
          issueId: null,
          pluginId: "plugin-1",
          externalId: "ext-step-1",
        },
      }),
    );
  });
});
describe("mission execution source snapshots", () => {
  it("returns native-only, plugin-only, and mixed snapshots keyed by mission id", async () => {
    const companyId = randomUUID();
    const nativeMissionId = randomUUID();
    const pluginMissionId = randomUUID();
    const mixedMissionId = randomUUID();
    const pluginId = randomUUID();
    const nativeRunId = randomUUID();
    const mixedNativeRunId = randomUUID();
    const pluginRunId = randomUUID();
    const pluginStepRunId = randomUUID();
    const mixedPluginRunId = randomUUID();
    const nativeRuns = [
      {
        id: nativeRunId,
        workflowId: "workflow-1",
        companyId,
        missionId: nativeMissionId,
        status: "running",
        triggeredBy: "scheduler",
        startedAt: null,
        completedAt: null,
        createdAt: new Date("2026-05-04T00:00:00.000Z"),
      },
      {
        id: mixedNativeRunId,
        workflowId: "workflow-2",
        companyId,
        missionId: mixedMissionId,
        status: "completed",
        triggeredBy: "manual",
        startedAt: null,
        completedAt: new Date("2026-05-04T00:02:00.000Z"),
        createdAt: new Date("2026-05-04T00:01:00.000Z"),
      },
    ];

    const pluginRunEntities = [
      {
        id: pluginRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "plugin-run-ext-1",
        title: "Plugin Workflow Run",
        status: "running",
        data: {
          companyId,
          missionId: pluginMissionId,
          workflowId: "plugin-workflow-1",
          workflowName: "Plugin Workflow",
          status: "timeout",
          triggerSource: "schedule",
        },
        createdAt: new Date("2026-05-04T00:03:00.000Z"),
        updatedAt: new Date("2026-05-04T00:04:00.000Z"),
      },
      {
        id: mixedPluginRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "plugin-run-ext-2",
        title: "Mixed Plugin Workflow Run",
        status: "completed",
        data: {
          companyId,
          missionId: mixedMissionId,
          workflowId: "plugin-workflow-2",
          workflowName: "Mixed Plugin Workflow",
          status: "success",
          triggerSource: "plugin",
        },
        createdAt: new Date("2026-05-04T00:05:00.000Z"),
        updatedAt: new Date("2026-05-04T00:06:00.000Z"),
      },
    ];

    const pluginStepRunEntities = [
      {
        id: pluginStepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: companyId,
        externalId: "plugin-step-ext-1",
        title: "plugin-step",
        status: "failed",
        data: {
          workflowRunId: pluginRunId,
          stepId: "plugin-step",
          issueId: null,
          status: "error",
        },
        createdAt: new Date("2026-05-04T00:04:30.000Z"),
        updatedAt: new Date("2026-05-04T00:04:30.000Z"),
      },
    ];

    let pluginEntityQueryCount = 0;
    const db = {
      select() {
        return {
          from(table: unknown) {
            return {
              where() {
                if (table === workflowRuns) {
                  return Promise.resolve(nativeRuns);
                }

                if (table === pluginEntities) {
                  pluginEntityQueryCount += 1;
                  return Promise.resolve(
                    pluginEntityQueryCount === 1 ? pluginRunEntities : pluginStepRunEntities,
                  );
                }

                throw new Error("Unexpected table in mission execution source test");
              },
            };
          },
        };
      },
    };

    const snapshots = await listMissionExecutionSourceSnapshots(db, {
      companyId,
      missionIds: [nativeMissionId, pluginMissionId, mixedMissionId],
    } as never);

    expect(Object.keys(snapshots).sort()).toEqual(
      [mixedMissionId, nativeMissionId, pluginMissionId].sort(),
    );

    expect(snapshots[nativeMissionId]?.units.map((unit) => unit.kind)).toEqual([
      "native_workflow_run",
    ]);

    expect(snapshots[pluginMissionId]?.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin_workflow_run",
          id: pluginRunId,
          status: "timed_out",
        }),
        expect.objectContaining({
          kind: "plugin_workflow_step_run",
          id: pluginStepRunId,
          workflowRunId: pluginRunId,
          stepId: "plugin-step",
          issueId: null,
          status: "failed",
        }),
      ]),
    );

    expect(snapshots[mixedMissionId]?.units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "native_workflow_run",
          id: mixedNativeRunId,
          status: "completed",
        }),
        expect.objectContaining({
          kind: "plugin_workflow_run",
          id: mixedPluginRunId,
          status: "completed",
        }),
      ]),
    );
  });
});

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission execution source tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("mission execution source snapshots with real query predicates", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-execution-sources-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(pluginEntities);
    await db.delete(plugins);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompanyWithMission(label: string) {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: `${label} Company`,
      issuePrefix: label.replace(/[^A-Z0-9]/gi, "").slice(0, 8).toUpperCase(),
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: `${label} Owner`,
      role: "operator",
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
      title: `${label} Mission`,
      status: "active",
    });

    return { companyId, ownerAgentId, missionId };
  }

  async function seedPlugin() {
    const pluginId = randomUUID();
    await db.insert(plugins).values({
      id: pluginId,
      pluginKey: `workflow-engine-${pluginId}`,
      packageName: "@paperclipai/plugin-workflow-engine-test",
      version: "0.0.0-test",
      categories: [],
      manifestJson: {
        id: `workflow-engine-${pluginId}`,
        name: "Workflow Engine Test",
        version: "0.0.0-test",
        apiVersion: 1,
      } as never,
      status: "installed",
    });
    return pluginId;
  }

  it("enforces company scope and links plugin step-runs by external run id fallback", async () => {
    const first = await seedCompanyWithMission("MESONE");
    const second = await seedCompanyWithMission("MESTWO");
    const pluginId = await seedPlugin();
    const validRunId = randomUUID();
    const scopedLeakRunId = randomUUID();
    const mismatchedDataRunId = randomUUID();
    const validStepRunId = randomUUID();
    const ignoredStepRunId = randomUUID();

    await db.insert(pluginEntities).values([
      {
        id: validRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "external-plugin-run-1",
        title: "Valid plugin run",
        status: "running",
        data: {
          companyId: first.companyId,
          missionId: first.missionId,
          workflowId: "plugin-workflow-1",
          workflowName: "Plugin Workflow",
          status: "running",
        },
      },
      {
        id: scopedLeakRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: second.companyId,
        externalId: "scoped-leak-run",
        title: "Wrong scope plugin run",
        status: "running",
        data: {
          companyId: first.companyId,
          missionId: first.missionId,
          workflowId: "plugin-workflow-leak",
          workflowName: "Wrong Scope Workflow",
          status: "running",
        },
      },
      {
        id: mismatchedDataRunId,
        pluginId,
        entityType: "workflow-run",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "mismatched-data-run",
        title: "Mismatched data company run",
        status: "running",
        data: {
          companyId: second.companyId,
          missionId: first.missionId,
          workflowId: "plugin-workflow-mismatch",
          workflowName: "Mismatched Data Workflow",
          status: "running",
        },
      },
      {
        id: validStepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: first.companyId,
        externalId: "valid-plugin-step-1",
        title: "External id linked step",
        status: "failed",
        data: {
          runId: "external-plugin-run-1",
          stepId: "external-step",
          status: "error",
        },
      },
      {
        id: ignoredStepRunId,
        pluginId,
        entityType: "workflow-step-run",
        scopeKind: "company",
        scopeId: second.companyId,
        externalId: "ignored-plugin-step-1",
        title: "Wrong scope step",
        status: "failed",
        data: {
          runId: "external-plugin-run-1",
          companyId: first.companyId,
          stepId: "wrong-scope-step",
          status: "error",
        },
      },
    ]);

    const snapshots = await listMissionExecutionSourceSnapshots(db, {
      companyId: first.companyId,
      missionIds: [first.missionId],
    });

    const units = snapshots[first.missionId]?.units ?? [];
    expect(units.map((unit) => unit.id).sort()).toEqual([validRunId, validStepRunId].sort());
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "plugin_workflow_run",
          id: validRunId,
          externalId: "external-plugin-run-1",
        }),
        expect.objectContaining({
          kind: "plugin_workflow_step_run",
          id: validStepRunId,
          workflowRunId: "external-plugin-run-1",
          stepId: "external-step",
          status: "failed",
        }),
      ]),
    );
    expect(units).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: scopedLeakRunId }),
        expect.objectContaining({ id: mismatchedDataRunId }),
        expect.objectContaining({ id: ignoredStepRunId }),
      ]),
    );
  });
});
