// @vitest-environment node
// Regression coverage for the stale-assignee fix (AREA-1).
// The workflow editor used to persist a stale `agentId` inside the generic
// `extra` bag when a step's agent was changed by name. The server resolves
// `agentId ?? agentName`, so the stale id won and the OLD agent executed.
// These tests lock the contract: agentId is a first-class StepDraft field,
// never hides in `extra`, and stepsToJson emits a consistent id+name pair.

import { describe, expect, it } from "vitest";
import { workflowStepDefinitionSchema } from "@paperclipai/shared";
import { jsonToSteps, stepsToJson } from "./Workflows";
import type { StepDraft } from "./Workflows";

type StepsInput = Parameters<typeof jsonToSteps>[0];

const TARGET = "3f2504e0-4f89-11d3-9a0c-0305e82c3301";

function step(over: Record<string, unknown> = {}): StepsInput[number] {
  return {
    id: "s1",
    title: "Step 1",
    type: "agent",
    agentName: "Old Agent",
    ...over,
  } as unknown as StepsInput[number];
}

function roundTrip(over: Record<string, unknown>): Record<string, unknown> {
  const drafts = jsonToSteps([step(over)]);
  return stepsToJson(drafts)[0] as Record<string, unknown>;
}

describe("Workflows editor serialization — stale assignee (AREA-1)", () => {
  it("jsonToSteps hydrates agentId as a first-class field and strips it from extra", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    expect(drafts[0].agentId).toBe("OLD");
    expect(drafts[0].agentName).toBe("Old Agent");
    // The stale id must NOT also linger in the generic extra bag.
    expect(drafts[0].extra).not.toHaveProperty("agentId");
  });

  it("changing the agent persists a consistent agentId+agentName pair with no stale id", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    // Simulate the agent <select> onChange writing BOTH the new id and name.
    drafts[0].agentId = "NEW";
    drafts[0].agentName = "New Agent";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentId).toBe("NEW");
    expect(out.agentName).toBe("New Agent");
    // The previous id must be gone entirely.
    expect(JSON.stringify(out)).not.toMatch(/OLD/);
    expect(Object.keys(out).filter((k) => k === "agentId")).toEqual(["agentId"]);
  });

  it("clearing the agent writes neither agentId nor agentName", () => {
    const drafts = jsonToSteps([step({ agentId: "OLD" })]);
    drafts[0].agentId = "";
    drafts[0].agentName = "";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out).not.toHaveProperty("agentId");
    expect(out).not.toHaveProperty("agentName");
  });

  it("legacy name-only step (no agentId) round-trips name-only so the server resolves by name", () => {
    const drafts = jsonToSteps([step({ agentName: "Solo", agentId: undefined })]);
    expect(drafts[0].agentId).toBe("");
    expect(drafts[0].agentName).toBe("Solo");
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentName).toBe("Solo");
    expect(out).not.toHaveProperty("agentId");
  });

  it("a stale agentId hiding in extra does not leak into persisted json (defense-in-depth)", () => {
    // Reproduces the pre-fix data shape: a stale id carried only in `extra`.
    const drafts: StepDraft[] = jsonToSteps([step({ agentName: "X" })]);
    (drafts[0].extra as Record<string, unknown>)["agentId"] = "STALE";
    // User changes the agent by name and the draft carries no first-class id.
    drafts[0].agentName = "Y";
    drafts[0].agentId = "";
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.agentName).toBe("Y");
    expect(out).not.toHaveProperty("agentId");
    expect(JSON.stringify(out)).not.toMatch(/STALE/);
  });

    it("round-trip of a freshly authored producer step keeps graphWorkProductRequired", () => {
      // Belts-and-suspenders: the workProduct flag survives the same serialization
      // path the assignee fix touched (AREA-2 UI exposure relies on this).
      const out = roundTrip({ agentName: "Producer", agentId: "P1", graphWorkProductRequired: true });
    expect(out.graphWorkProductRequired).toBe(true);
      expect(out.agentId).toBe("P1");
      expect(out.agentName).toBe("Producer");
    });

    it("round-trips work product pattern plus resource and secret refs", () => {
      const out = roundTrip({
        graphWorkProductRequired: true,
        graphWorkProductPattern: "reports/*.html",
        graphResourceRefs: ["kb:market-rules", "file:brief"],
        graphSecretRefs: ["secret:api-token"],
      });
      expect(out.graphWorkProductRequired).toBe(true);
      expect(out.graphWorkProductPattern).toBe("reports/*.html");
      expect(out.graphResourceRefs).toEqual(["kb:market-rules", "file:brief"]);
      expect(out.graphSecretRefs).toEqual(["secret:api-token"]);
    });

    it("hydrates a step contract into first-class draft fields and strips it from extra", () => {
      const drafts = jsonToSteps([step({
        contract: {
          preconditions: ["Data source brief is registered"],
          postconditions: ["Report registers a workProduct"],
          undefinedBehaviors: ["If the source is unreachable the content is undefined — report blocked"],
        },
      })]);
      expect(drafts[0].contractPreconditions).toBe("Data source brief is registered");
      expect(drafts[0].contractPostconditions).toBe("Report registers a workProduct");
      expect(drafts[0].contractUndefinedBehaviors).toBe("If the source is unreachable the content is undefined — report blocked");
      expect(drafts[0].extra).not.toHaveProperty("contract");
    });

    it("round-trips an edited step contract as a normalized contract object", () => {
      const drafts = jsonToSteps([step({
        contract: { postconditions: ["existing"] },
      })]);
      drafts[0].contractPreconditions = "Upstream brief exists\n\n  \nSecond precondition";
      const out = stepsToJson(drafts)[0] as Record<string, unknown>;
      expect(out.contract).toEqual({
        preconditions: ["Upstream brief exists", "Second precondition"],
        postconditions: ["existing"],
      });
    });

    it("drops the contract entirely when every section is cleared", () => {
      const drafts = jsonToSteps([step({
        contract: { postconditions: ["existing"] },
      })]);
      drafts[0].contractPostconditions = "";
      const out = stepsToJson(drafts)[0] as Record<string, unknown>;
      expect(out).not.toHaveProperty("contract");
    });
  });

describe("Workflows editor serialization — workflow child step round-trip", () => {
  it("preserves targetWorkflowId, wait:true, and inputs through jsonToSteps → stepsToJson", () => {
    // n8n "Execute Workflow" type:"workflow" 스텝. 편집기 전용 UI 필드가 아니므로
    // extra bag 을 통해 load → save 라운드트립에서 유실되지 않아야 한다.
    const drafts = jsonToSteps([step({
      type: "workflow",
      targetWorkflowId: TARGET,
      wait: true,
      inputs: { q: "{$runDate}" },
    })]);
    expect(drafts[0].type).toBe("workflow");
    // [descope v1 D1] literal true 만 1급 필드로 승격된다.
    expect(drafts[0].wait).toBe(true);
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.type).toBe("workflow");
    expect(out.targetWorkflowId).toBe(TARGET);
    expect(out.wait).toBe(true);
    expect(out.inputs).toEqual({ q: "{$runDate}" });
    expect(workflowStepDefinitionSchema.safeParse(out).success).toBe(true);
  });

  it("round-trips an omitted wait as omitted on the wire and the shared validator accepts it", () => {
    // [descope v1 D1] 생략된 wait 는 true 로 강등되지 않고 그대로 생략되며,
    // 런타임 정규화(wait 생략 = true)는 공유 검증기/서버 계약이다.
    const out = roundTrip({ type: "workflow", targetWorkflowId: TARGET, inputs: { q: "x" } });
    expect(out.wait).toBeUndefined();
    expect(JSON.parse(JSON.stringify(out))).not.toHaveProperty("wait");
    expect(workflowStepDefinitionSchema.safeParse(out).success).toBe(true);
  });

  it("keeps wait/inputs in the extra bag and never routes them into agent/tool cleanup branches", () => {
    const drafts = jsonToSteps([step({
      type: "workflow",
      targetWorkflowId: TARGET,
      wait: true,
    })]);
    expect(drafts[0].extra.targetWorkflowId).toBe(TARGET);
    expect(drafts[0].extra.wait).toBe(true);
  });

  it("refuses wait:false through the shared validator contract without coercing or stripping it", () => {
    // [descope v1 D1] fire-and-forget 제거 — import 된 false 는 true 로 강등되거나
    // 조용히 제거되지 않고 그대로 통과되며, 공유 검증기가 parse 실패로 거부한다.
    const out = roundTrip({ type: "workflow", targetWorkflowId: TARGET, wait: false });
    expect(out.wait).toBe(false);
    const parsed = workflowStepDefinitionSchema.safeParse(out);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.some((issue) => issue.path.includes("wait"))).toBe(true);
    }
  });

  it("promotes only literal true — a string wait passes through and is refused by the shared validator", () => {
    const drafts = jsonToSteps([step({ type: "workflow", targetWorkflowId: TARGET, wait: "true" })]);
    expect(drafts[0].wait).toBeUndefined();
    expect(drafts[0].extra.wait).toBe("true");
    const out = stepsToJson(drafts)[0] as Record<string, unknown>;
    expect(out.wait).toBe("true");
    expect(workflowStepDefinitionSchema.safeParse(out).success).toBe(false);
  });

  it("refuses a workflow draft carrying retry policy fields (kept intact, refused by the shared validator)", () => {
    // [descope v1 D2] workflow 스텝 재시도 정책 금지 — 직렬화가 재시도 필드를 지우지 않고
    // (침묵 무시 금지) 그대로 통과시켜 공유 검증기가 거부한다.
    const out = roundTrip({
      type: "workflow",
      targetWorkflowId: TARGET,
      onFailure: "retry",
      maxRetries: "3",
      graphRetryDelaySeconds: "30",
      graphRetryBackoff: "exponential",
      graphRetryJitter: true,
    });
    expect(out.onFailure).toBe("retry");
    expect(out.maxRetries).toBe(3);
    expect(out.graphRetryDelaySeconds).toBe(30);
    expect(out.graphRetryBackoff).toBe("exponential");
    expect(out.graphRetryJitter).toBe(true);
    const parsed = workflowStepDefinitionSchema.safeParse(out);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const issuePaths = new Set(parsed.error.issues.map((issue) => issue.path[0]));
      expect(issuePaths.has("onFailure")).toBe(true);
      expect(issuePaths.has("maxRetries")).toBe(true);
      expect(issuePaths.has("graphRetryDelaySeconds")).toBe(true);
      expect(issuePaths.has("graphRetryBackoff")).toBe(true);
      expect(issuePaths.has("graphRetryJitter")).toBe(true);
    }
  });
});
