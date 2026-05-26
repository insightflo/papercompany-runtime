import { describe, expect, it } from "vitest";
import { parseMissionOwnerPlanDecision } from "../services/mission-owner-plan-decisions.js";

const validDecision = {
  missionId: "mission-1",
  missionGoal: "Ship controlled rollout",
  selectedExecutionUnits: [{ id: "unit-1", title: "Run smoke" }],
  ruleRefs: ["rule:security"],
  kbRefs: ["kb:rollout"],
  requiredInputs: ["stagingUrl"],
  successCriteria: ["smoke passes"],
  steps: [{ id: "step-1", title: "Verify staging" }],
};

describe("parseMissionOwnerPlanDecision", () => {
  it("returns null for plain comments without the exact decision heading", () => {
    expect(parseMissionOwnerPlanDecision("Looks good. {\"missionId\":\"mission-1\"}")).toBeNull();
  });

  it("parses a fenced json decision block after the exact heading and preserves materialization fields", () => {
    const result = parseMissionOwnerPlanDecision(`Intro text

### Mission owner plan decision

\`\`\`json
${JSON.stringify(validDecision, null, 2)}
\`\`\`

Tail text`);

    expect(result).toEqual({
      ok: true,
      decision: validDecision,
    });
  });

  it("parses a raw json object immediately after the exact heading", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
${JSON.stringify({ ...validDecision, goal: "Use goal field" })}`);

    expect(result).toEqual({
      ok: true,
      decision: { ...validDecision, goal: "Use goal field" },
    });
  });

  it("returns the latest valid decision when multiple decision blocks exist", () => {
    const first = { ...validDecision, missionId: "mission-old" };
    const latest = { ...validDecision, missionId: "mission-latest", selectedExecutionUnits: [{ id: "unit-latest" }] };

    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
${JSON.stringify(first)}
\`\`\`

Comment between decisions.

### Mission owner plan decision
\`\`\`json
${JSON.stringify(latest)}
\`\`\``);

    expect(result).toEqual({ ok: true, decision: latest });
  });

  it("returns the latest valid decision when a later decision block has invalid json", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
${JSON.stringify(validDecision)}
\`\`\`

### Mission owner plan decision
\`\`\`json
{ invalid json
\`\`\``);

    expect(result).toEqual({ ok: true, decision: validDecision });
  });

  it("returns a diagnostic result instead of throwing when decision json is invalid", () => {
    const result = parseMissionOwnerPlanDecision(`### Mission owner plan decision
\`\`\`json
{ invalid json
\`\`\``);

    expect(result).toEqual({
      ok: false,
      error: expect.objectContaining({
        code: "invalid_json",
        message: expect.stringContaining("Invalid Mission owner plan decision JSON"),
      }),
    });
  });

  it("ignores json-looking blocks under other headings", () => {
    const result = parseMissionOwnerPlanDecision(`### Other heading
\`\`\`json
${JSON.stringify(validDecision)}
\`\`\``);

    expect(result).toBeNull();
  });

  it("requires the exact h3 markdown heading", () => {
    expect(parseMissionOwnerPlanDecision(`## Mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
    expect(parseMissionOwnerPlanDecision(`#### Mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
    expect(parseMissionOwnerPlanDecision(`### mission owner plan decision
${JSON.stringify(validDecision)}`)).toBeNull();
  });
});
