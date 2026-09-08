import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { ResumePreview } from "../services/workflow/resume/preview.js";
import type { ResumeRequestView } from "../services/workflow/resume/request-store.js";
import { projectResumePreview, projectResumeRequest } from "../services/workflow/resume/public-views.js";
import { snapshotState } from "./helpers/workflow-resume-snapshot-fixture.js";

function requestView(state: string): ResumeRequestView {
  const scope = snapshotState().scope;
  return {
    schemaVersion: 1, id: randomUUID(), companyId: scope.companyId, missionId: scope.missionId,
    workflowRunId: scope.workflowRunId, idempotencyKey: randomUUID(), requestHash: "private",
    snapshotHash: "private", definitionHash: "private", beforeState: { secret: "PRIVATE" },
    appliedGenerations: {}, state, code: "display_code", leaseOwner: "private", leaseUntil: null,
    deliveryAttempts: 3, acceptedAt: null, createdAt: "2026-01-01T00:00:00.000Z", execution: null,
    requestBody: { schemaVersion: 1, mode: "resume_from_step", ...scope,
      idempotencyKey: randomUUID(), snapshotToken: "PRIVATE_TOKEN", reason: "PRIVATE_REASON" },
  };
}

describe("pure public projections", () => {
  it.each(["pending_delivery", "accepted", "blocked", "cancelled"] as const)("whitelists request state %s", (state) => {
    const internal = requestView(state);
    expect(projectResumeRequest(internal)).toEqual({ id: internal.id, workflowRunId: internal.workflowRunId,
      startStepId: "step-1", state, acceptanceId: null, code: "display_code", createdAt: internal.createdAt });
  });

  it("acceptance identity comes from execution id even before execution completion", () => {
    const internal = requestView("accepted");
    internal.execution = { id: randomUUID(), state: "queued", authorityVersion: 4, generations: {},
      attempts: 0, createdAt: internal.createdAt, completedAt: null, code: null };
    expect(projectResumeRequest(internal).acceptanceId).toBe(internal.execution.id);
  });

  it.each(["body", "state", "companyId", "missionId", "workflowRunId"])("invalid %s throws fixed internal error", (kind) => {
    const internal = requestView("accepted");
    if (kind === "body") internal.requestBody.secret = "PRIVATE";
    else if (kind === "state") internal.state = "PRIVATE_STATE";
    else internal.requestBody[kind] = randomUUID();
    expect(() => projectResumeRequest(internal)).toThrowError(expect.objectContaining({ status: 500, message: "invalid_resume_record" }));
  });

  function previewInput() {
    const state = snapshotState();
    const preview: ResumePreview = { schemaVersion: 1, scope: state.scope, definitionHash: state.definitionHash,
      eligible: false, affectedStepIds: ["step-1"], preservedStepIds: ["step-2"], generationPossible: true,
      blockers: [], token: null, expiresAt: null };
    const frozenSteps = [{ id: "step-1", name: "Frozen one", agentId: "" }, { id: "step-2", name: "Frozen two", agentId: "" }];
    return { preview, state, frozenSteps, budget: "verified" as const };
  }

  it("copies evidence and approvals from state without leaking internal fields or aliasing", () => {
    const input = previewInput();
    const result = projectResumePreview(input);
    expect(result.evidence).toEqual(input.state.evidence);
    expect(result.evidence[0]).not.toBe(input.state.evidence[0]);
    expect(result.approvals).toEqual([{ stepId: "step-1", required: true }]);
    expect(result.approvals[0]).not.toBe(input.state.approvals[0]);
    expect(result.preserved).toEqual([{ stepId: "step-2", name: "Frozen two" }]);
    expect(projectResumePreview({ ...input, state: null })).toMatchObject({ evidence: [], approvals: [] });
  });

  it("only string step identities survive blocker redaction, with top-level precedence", () => {
    const input = previewInput();
    const blockers = [
      { code: "a", message: "a", stepId: "direct", detail: { stepId: "nested", secret: "PRIVATE" } },
      { code: "b", message: "b", stepId: 5, detail: { stepId: "nested", secret: "PRIVATE" } },
      { code: "c", message: "c", detail: { stepId: 5, secret: "PRIVATE" } },
    ];
    input.preview.blockers = blockers;
    expect(projectResumePreview(input).blockers).toEqual([
      { code: "a", message: "a", stepId: "direct" }, { code: "b", message: "b", stepId: "nested" },
      { code: "c", message: "c" },
    ]);
  });

  it.each(["affected", "preserved"])("missing frozen %s label is an internal invariant failure", (kind) => {
    const input = previewInput();
    input.frozenSteps = input.frozenSteps.filter((s) => s.id !== (kind === "affected" ? "step-1" : "step-2"));
    expect(() => projectResumePreview(input)).toThrowError(expect.objectContaining({ status: 500 }));
  });
});
