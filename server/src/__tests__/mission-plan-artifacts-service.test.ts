import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agents,
  companies,
  createDb,
  missionPlanArtifacts,
  missions,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  asSelectedExecutionUnits,
  mergeMissionPlanRefs,
  missionPlanArtifactService,
  selectedExecutionUnitKey,
  summarizeMissionPlanForRuntime,
} from "../services/mission-plan-artifacts.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres mission plan artifact tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describe("mission plan refs v2 helpers", () => {
  it("preserves legacy refs while adding execution units", () => {
    const merged = mergeMissionPlanRefs(
      {
        oversightIssueId: "issue-1",
        workflowName: "Morning Workflow",
        sourceRunId: "run-1",
      },
      {
        executionUnits: [
          {
            kind: "native_workflow_run",
            sourceRef: { type: "native_workflow_run", id: "run-2" },
            status: "running",
          },
        ],
      },
    );

    expect(merged).toMatchObject({
      schemaVersion: 2,
      oversightIssueId: "issue-1",
      workflowName: "Morning Workflow",
      sourceRunId: "run-1",
      executionUnits: [
        expect.objectContaining({
          kind: "native_workflow_run",
          status: "running",
          sourceRef: { type: "native_workflow_run", id: "run-2" },
        }),
      ],
    });
  });

  it("dedupes execution units by sourceRef and lets incoming units update deterministically", () => {
    const merged = mergeMissionPlanRefs(
      {
        schemaVersion: 2,
        executionUnits: [
          {
            kind: "plugin_workflow_run",
            sourceRef: { type: "plugin_workflow_run", id: "plugin-run-1" },
            status: "pending",
            title: "Old title",
          },
        ],
      },
      {
        executionUnits: [
          {
            kind: "plugin_workflow_run",
            sourceRef: { type: "plugin_workflow_run", id: "plugin-run-1" },
            status: "failed",
            title: "Updated title",
          },
          {
            kind: "plugin_workflow_step_run",
            sourceRef: { type: "plugin_workflow_step_run", id: "plugin-step-1", workflowRunId: "plugin-run-1" },
            status: "timed_out",
          },
        ],
      },
    );

    expect(merged.executionUnits).toEqual([
      expect.objectContaining({
        kind: "plugin_workflow_run",
        sourceRef: { type: "plugin_workflow_run", id: "plugin-run-1" },
        status: "failed",
        title: "Updated title",
      }),
      expect.objectContaining({
        kind: "plugin_workflow_step_run",
        sourceRef: { type: "plugin_workflow_step_run", id: "plugin-step-1", workflowRunId: "plugin-run-1" },
        status: "timed_out",
      }),
    ]);
  });

  it("preserves v2 executionUnits and ruleRefs while adding v3 selectedExecutionUnits", () => {
    const merged = mergeMissionPlanRefs(
      {
        schemaVersion: 2,
        executionUnits: [{ sourceRef: { type: "workflow_run", id: "run-1" }, status: "completed" }],
        ruleRefs: [{ id: "approval-before-publish", mode: "approval_gate" }],
      },
      {
        selectedExecutionUnits: [
          {
            id: "wf:wf-1:step:comic",
            kind: "workflow_definition_step",
            selectionState: "selected",
            executionState: "not_materialized",
            reason: "Mission owner selected only the comic generation step.",
            sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "comic" },
          },
        ],
      },
    );

    expect(merged).toMatchObject({
      schemaVersion: 3,
      executionUnits: [{ sourceRef: { type: "workflow_run", id: "run-1" }, status: "completed" }],
      ruleRefs: [{ id: "approval-before-publish", mode: "approval_gate" }],
      selectedExecutionUnits: [
        expect.objectContaining({
          id: "wf:wf-1:step:comic",
          selectionState: "selected",
          reason: "Mission owner selected only the comic generation step.",
        }),
      ],
    });
  });

  it("keeps v2 schemaVersion when selectedExecutionUnits are absent or invalid", () => {
    const legacyOnly = mergeMissionPlanRefs(
      { executionUnits: [{ sourceRef: { type: "workflow_run", id: "run-1" }, status: "running" }] },
      { ruleRefs: [{ id: "observe-cost", mode: "observation" }] },
    );
    expect(legacyOnly.schemaVersion).toBe(2);
    expect(legacyOnly.selectedExecutionUnits).toBeUndefined();

    const invalidSelected = mergeMissionPlanRefs(legacyOnly, {
      selectedExecutionUnits: [
        { selectionState: "selected", reason: "missing source", sourceRef: { type: "", id: "" } },
      ],
    });
    expect(invalidSelected.schemaVersion).toBe(2);
    expect(invalidSelected.selectedExecutionUnits).toBeUndefined();
  });

  it("dedupes selectedExecutionUnits by stable key and lets incoming update reason and state", () => {
    const merged = mergeMissionPlanRefs(
      {
        selectedExecutionUnits: [
          {
            id: "wf:wf-1:step:comic",
            selectionState: "candidate",
            reason: "Candidate before owner decision.",
            sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "comic" },
          },
        ],
      },
      {
        selectedExecutionUnits: [
          {
            id: "wf:wf-1:step:comic",
            selectionState: "selected",
            reason: "Owner selected this as the bounded replay unit.",
            sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "comic" },
          },
          {
            selectionState: "excluded",
            reason: "Publishing is explicitly out of scope for this replay.",
            sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "publish" },
          },
        ],
      },
    );

    expect(merged.schemaVersion).toBe(3);
    expect(merged.selectedExecutionUnits).toEqual([
      expect.objectContaining({
        id: "wf:wf-1:step:comic",
        selectionState: "selected",
        reason: "Owner selected this as the bounded replay unit.",
      }),
      expect.objectContaining({
        selectionState: "excluded",
        reason: "Publishing is explicitly out of scope for this replay.",
        sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "publish" },
      }),
    ]);
    const selectedUnits = asSelectedExecutionUnits(merged.selectedExecutionUnits);
    expect(selectedExecutionUnitKey(selectedUnits[1])).toBe("workflow_definition_step:wf-1:publish");
  });

  it("rejects malformed selectedExecutionUnits with missing sourceRef, state, or reason", () => {
    const units = asSelectedExecutionUnits([
      { selectionState: "selected", reason: "missing source", sourceRef: { type: "", id: "" } },
      { selectionState: "nonsense", reason: "bad state", sourceRef: { type: "workflow_definition_step", id: "wf-1" } },
      { selectionState: "selected", reason: " ", sourceRef: { type: "workflow_definition_step", id: "wf-1" } },
      { selectionState: "selected", reason: "valid", sourceRef: { type: "workflow_definition_step", id: "wf-1" } },
    ]);

    expect(units).toEqual([
      expect.objectContaining({
        selectionState: "selected",
        reason: "valid",
        sourceRef: { type: "workflow_definition_step", id: "wf-1" },
      }),
    ]);
  });

  it("rejects satisfied_by_prior_artifact without at least one valid evidence ref", () => {
    const units = asSelectedExecutionUnits([
      {
        selectionState: "satisfied",
        dependencyTreatment: "satisfied_by_prior_artifact",
        reason: "Claimed satisfied but no evidence.",
        sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "collect" },
      },
      {
        selectionState: "satisfied",
        dependencyTreatment: "satisfied_by_prior_artifact",
        reason: "Claimed satisfied but evidence is malformed.",
        sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "collect" },
        evidenceRefs: [{ label: "No type" }],
      },
      {
        selectionState: "satisfied",
        dependencyTreatment: "satisfied_by_prior_artifact",
        reason: "Prior collection artifact exists.",
        sourceRef: { type: "workflow_definition_step", id: "wf-1", stepId: "collect" },
        evidenceRefs: [{ type: "artifact", id: "artifact-1" }],
      },
    ]);

    expect(units).toEqual([
      expect.objectContaining({
        selectionState: "satisfied",
        dependencyTreatment: "satisfied_by_prior_artifact",
        reason: "Prior collection artifact exists.",
        evidenceRefs: [{ type: "artifact", id: "artifact-1" }],
      }),
    ]);
  });
});

describeEmbeddedPostgres("mission plan artifact service", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-mission-plan-artifacts-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  afterEach(async () => {
    await db.delete(missionPlanArtifacts);
    await db.delete(missions);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedMission() {
    const companyId = randomUUID();
    const ownerAgentId = randomUUID();
    const missionId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Mission Plan Company",
      issuePrefix: `MP${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: ownerAgentId,
      companyId,
      name: "Mission Owner",
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
      title: "Customer homepage rollout",
      description: "Coordinate launch readiness across content and QA.",
      status: "planning",
    });

    return { companyId, ownerAgentId, missionId };
  }

  it("creates and reads an initial active mission plan artifact with JSON payloads", async () => {
    const { companyId, ownerAgentId, missionId } = await seedMission();

    const created = await missionPlanArtifactService(db).createInitialMissionPlan({
      companyId,
      missionId,
      refs: { planningIssueId: "plan-issue-1" },
      assumptions: ["Launch scope is limited to the public homepage."],
      requiredInputs: [{ key: "qa-owner", status: "missing" }],
      successCriteria: [{ description: "Homepage content is approved." }],
      risks: [{ description: "Approval delay", severity: "observe" }],
      steps: [{ id: "step-1", title: "Confirm launch owner", status: "planned" }],
    });

    expect(created).toEqual(expect.objectContaining({
      companyId,
      missionId,
      ownerAgentId,
      revision: 1,
      status: "active",
      missionGoal: expect.stringContaining("Customer homepage rollout"),
    }));
    expect(created.refs).toEqual({ planningIssueId: "plan-issue-1" });
    expect(created.requiredInputs).toEqual([{ key: "qa-owner", status: "missing" }]);

    const rows = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));
    expect(rows).toHaveLength(1);

    const active = await missionPlanArtifactService(db).getActiveMissionPlan({ companyId, missionId });
    expect(active?.id).toBe(created.id);
  });

  it("creates revisions by superseding the previous active artifact", async () => {
    const { companyId, missionId } = await seedMission();
    const svc = missionPlanArtifactService(db);

    const initial = await svc.createInitialMissionPlan({ companyId, missionId });
    const revision = await svc.createMissionPlanRevision({
      companyId,
      missionId,
      missionGoal: "Customer homepage rollout — revised QA-first launch plan",
      steps: [
        { id: "qa", title: "Run QA checklist", status: "planned" },
        { id: "approve", title: "Collect final approval", status: "planned" },
      ],
    });

    expect(revision.revision).toBe(2);
    expect(revision.status).toBe("active");

    const rows = await db
      .select()
      .from(missionPlanArtifacts)
      .where(eq(missionPlanArtifacts.missionId, missionId));
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: initial.id, revision: 1, status: "superseded" }),
      expect.objectContaining({ id: revision.id, revision: 2, status: "active" }),
    ]));

    const active = await svc.getActiveMissionPlan({ companyId, missionId });
    expect(active?.id).toBe(revision.id);
  });

  it("summarizes only bounded active revision context for runtime", async () => {
    const summary = summarizeMissionPlanForRuntime({
      id: "plan-1",
      companyId: "company-1",
      missionId: "mission-1",
      revision: 3,
      status: "active",
      ownerAgentId: "agent-1",
      missionGoal: "A".repeat(400),
      refs: { planningIssueId: "issue-1", workflowRunIds: ["run-1"] },
      assumptions: ["private assumption that should not be rendered verbatim"],
      requiredInputs: [
        { key: "customer-window", status: "missing" },
        { key: "operator-approval", status: "received" },
      ],
      successCriteria: [{ description: "Deployment evidence exists" }],
      risks: [{ description: "Risk body should stay out of brief", severity: "observe" }],
      steps: [
        { id: "step-1", title: "First very long step title that should be truncated in the runtime summary", status: "planned" },
        { id: "step-2", title: "Second step", status: "delegated" },
        { id: "step-3", title: "Third step", status: "blocked" },
        { id: "step-4", title: "Fourth step", status: "planned" },
      ],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(summary).toMatchObject({
      available: true,
      missionPlanId: "plan-1",
      revision: 3,
      status: "active",
      requiredInputsCount: 2,
      successCriteriaCount: 1,
      riskCount: 1,
      stepCount: 4,
      executionUnitCount: 0,
      blockedOrFailedUnitCount: 0,
      ruleRefCount: 0,
      refs: { planningIssueId: "issue-1", workflowRunIds: ["run-1"] },
    });
    expect(summary.missionGoal.length).toBeLessThanOrEqual(220);
    expect(summary.openRequiredInputs).toEqual(["customer-window"]);
    expect(summary.stepSummary).toHaveLength(3);
    expect(JSON.stringify(summary)).not.toContain("private assumption");
    expect(JSON.stringify(summary)).not.toContain("Risk body should stay out of brief");
  });

  it("summarizes v2 refs with execution unit and rule counts", async () => {
    const summary = summarizeMissionPlanForRuntime({
      id: "plan-v2",
      companyId: "company-1",
      missionId: "mission-1",
      revision: 1,
      status: "active",
      ownerAgentId: "agent-1",
      missionGoal: "Coordinate a plugin-backed workflow mission.",
      refs: {
        schemaVersion: 2,
        executionUnits: [
          { sourceRef: { type: "native_workflow_run", id: "run-1" }, status: "running" },
          { sourceRef: { type: "plugin_workflow_step_run", id: "step-1" }, status: "failed" },
          { sourceRef: { type: "plugin_workflow_step_run", id: "step-2" }, status: "blocked" },
          { sourceRef: { type: "plugin_workflow_step_run", id: "step-3" }, status: "completed" },
        ],
        ruleRefs: [
          { id: "approval-before-publish", mode: "approval_gate" },
          { id: "observe-cost", mode: "observation" },
        ],
      },
      assumptions: [],
      requiredInputs: [],
      successCriteria: [],
      risks: [],
      steps: [],
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    expect(summary).toMatchObject({
      available: true,
      executionUnitCount: 4,
      blockedOrFailedUnitCount: 2,
      ruleRefCount: 2,
    });
  });
});
