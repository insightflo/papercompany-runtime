import { describe, expect, it } from "vitest";
import {
  createOperatorDecisionSchema,
  operatorDecisionDefinitionSchema,
  operatorDecisionListQuerySchema,
} from "./operator-decision.js";

const option = {
  id: "candidate-1",
  label: "Candidate one",
  description: null,
  facts: [{ label: "Fit", value: "Strong", status: "known" as const }],
  evidenceRefs: [{ label: "Source", href: "https://example.com/source" }],
};

const definition = {
  options: [option],
  actions: [{
    id: "submit",
    label: "Submit",
    outcome: "submit" as const,
    tone: "primary" as const,
    requiresSelection: true,
  }],
  selection: { min: 1, max: 1 },
  comment: { mode: "optional" as const, label: "Comment", placeholder: null, maxLength: 200 },
  approvedScope: ["Internal proposal only"],
  forbiddenScope: ["External contact"],
};

const createInput = {
  schemaVersion: 1 as const,
  requestKey: "workflow:run-1:choice",
  priority: "high" as const,
  interactionType: "single_select" as const,
  title: " Choose an opportunity ",
  description: " Select one. ",
  sourceType: "workflow_step",
  sourceId: "run-1:step-2",
  sourceContext: {
    missionId: null,
    workflowId: "workflow-1",
    workflowRunId: "run-1",
    artifactRefs: [{ label: "Shortlist", uri: "artifact:shortlist/1" }],
  },
  definition,
  issueId: null,
  continuationMode: "none" as const,
};

function expectInvalid(value: unknown) {
  expect(operatorDecisionDefinitionSchema.safeParse(value).success).toBe(false);
}

describe("operator decision definition", () => {
  it("normalizes NFC and trims bounded create strings", () => {
    const parsed = createOperatorDecisionSchema.parse(createInput);
    expect(parsed.title).toBe("Choose an opportunity");
    expect(parsed.description).toBe("Select one.");
    expect(parsed.requestKey).toBe("workflow:run-1:choice");
  });

  it("rejects unknown or omitted normalized keys", () => {
    expect(createOperatorDecisionSchema.safeParse({ ...createInput, actorId: "user-1" }).success).toBe(false);
    const { description: _description, ...missing } = createInput;
    expect(createOperatorDecisionSchema.safeParse(missing).success).toBe(false);
    expectInvalid({ ...definition, surprise: true });
  });

  it.each([
    ["request key", { ...createInput, requestKey: "bad key" }],
    ["request key bound", { ...createInput, requestKey: "x".repeat(161) }],
    ["title bound", { ...createInput, title: "x".repeat(201) }],
    ["description bound", { ...createInput, description: "x".repeat(4_001) }],
    ["source type bound", { ...createInput, sourceType: "x".repeat(81) }],
    ["source id bound", { ...createInput, sourceId: "x".repeat(201) }],
    ["context id bound", { ...createInput, sourceContext: { ...createInput.sourceContext, workflowId: "x".repeat(129) } }],
    ["artifact protocol", { ...createInput, sourceContext: { ...createInput.sourceContext, artifactRefs: [{ label: "bad", uri: "file:///tmp/a" }] } }],
    ["explicit issue mode", { ...createInput, continuationMode: "issue_current_assignee" }],
  ])("rejects %s violations", (_name, value) => {
    expect(createOperatorDecisionSchema.safeParse(value).success).toBe(false);
  });

  it("enforces the canonical create byte ceiling independently of field bounds", () => {
    const largeOptions = Array.from({ length: 50 }, (_, index) => ({
      ...option,
      id: `candidate-${index}`,
      description: "d".repeat(1_000),
      facts: Array.from({ length: 12 }, (_, factIndex) => ({
        label: `fact-${factIndex}`,
        value: "v".repeat(200),
        status: "known" as const,
      })),
    }));
    const oversized = {
      ...createInput,
      interactionType: "multi_select" as const,
      definition: { ...definition, options: largeOptions, selection: { min: 1, max: 50 } },
    };
    expect(Buffer.byteLength(JSON.stringify(oversized), "utf8")).toBeGreaterThan(65_536);
    expect(createOperatorDecisionSchema.safeParse(oversized).success).toBe(false);
  });

  it("enforces single-select shape", () => {
    expectInvalid({ ...definition, options: [] });
    expectInvalid({ ...definition, selection: { min: 1, max: 2 } });
    expectInvalid({ ...definition, options: [option, { ...option }] });
  });

  it("enforces multi-select shape and cardinality bounds", () => {
    const second = { ...option, id: "candidate-2" };
    const valid = { ...definition, options: [option, second], selection: { min: 1, max: 2 } };
    expect(operatorDecisionDefinitionSchema.parse(valid).selection).toEqual({ min: 1, max: 2 });
    expectInvalid({ ...valid, selection: { min: 0, max: 2 } });
    expectInvalid({ ...valid, selection: { min: 2, max: 1 } });
    expectInvalid({ ...valid, selection: { min: 1, max: 3 } });
  });

  it("enforces action-only shape", () => {
    const action = {
      ...definition,
      options: [],
      selection: null,
      actions: [{ ...definition.actions[0], requiresSelection: false }],
    };
    expect(operatorDecisionDefinitionSchema.parse(action).options).toEqual([]);
    expectInvalid({ ...action, options: [option] });
    expectInvalid({ ...action, selection: { min: 1, max: 1 } });
    expectInvalid({ ...action, actions: definition.actions });
  });

  it("enforces comment and collection bounds", () => {
    expectInvalid({ ...definition, comment: { mode: "disabled", label: "No", placeholder: null, maxLength: 0 } });
    expectInvalid({ ...definition, comment: { mode: "disabled", label: null, placeholder: null, maxLength: 1 } });
    expectInvalid({ ...definition, comment: { mode: "required", label: "", placeholder: null, maxLength: 20 } });
    expectInvalid({ ...definition, approvedScope: ["same", "same"] });
    expectInvalid({ ...definition, actions: Array.from({ length: 9 }, (_, i) => ({ ...definition.actions[0], id: `a${i}` })) });
    expectInvalid({ ...definition, options: Array.from({ length: 51 }, (_, i) => ({ ...option, id: `o${i}` })) });
  });

  it("validates strict list query and cursor bounds", () => {
    expect(operatorDecisionListQuerySchema.parse({})).toEqual({ view: "pending", limit: 50 });
    expect(operatorDecisionListQuerySchema.safeParse({ view: "pending", limit: "101" }).success).toBe(false);
    expect(operatorDecisionListQuerySchema.safeParse({ cursor: "x".repeat(513) }).success).toBe(false);
    expect(operatorDecisionListQuerySchema.safeParse({ unknown: "x" }).success).toBe(false);
  });
});

