import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agentToolGrants, agents, companies, createDb, toolDefinitions } from "@paperclipai/db";
import { validateDeclaredStructuralPlan } from "../services/missions/structural-materialization.js";
import {
  STRUCTURAL_VALIDATION_CAPABILITY,
  validateDeclaredStructuralPlanReadiness,
} from "../services/workflow/control-flow/structural-gate-readiness.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

describe("hybrid QA — pre-PLAN structural plan validation (topology)", () => {
  it("returns no errors for valid structural plan", () => {
    const units = [
      { id: "producer", kind: "mission_plan_unit", title: "[ACTION] Produce", sourceRef: { type: "mission_plan_unit", id: "producer" } },
      { id: "gate", kind: "mission_plan_unit", type: "tool", qaType: "structural", title: "[QA] Gate", toolNames: ["v"],
        dependsOn: ["producer"], sourceRef: { type: "mission_plan_unit", id: "gate-src" } },
      { id: "qa", kind: "mission_plan_unit", title: "[QA] Semantic", dependsOn: ["producer", "gate"],
        sourceRef: { type: "mission_plan_unit", id: "qa-src" } },
    ];
    expect(validateDeclaredStructuralPlan(units)).toEqual([]);
  });

  it("rejects duplicate aliases across ALL units", () => {
    // Two units (one structural, one producer) share alias "dup".
    const units = [
      { id: "dup", kind: "mission_plan_unit", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "dup-src" } },
      { id: "dup", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: [],
        sourceRef: { type: "mission_plan_unit", id: "dup" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => /duplicate/i.test(e) && e.includes("dup"))).toBe(true);
  });

  it("rejects unresolved dependency refs across dependency forms (dependencies + dependsOn + after)", () => {
    const units = [
      { id: "p", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "p" } },
      { id: "gate", type: "tool", qaType: "structural", toolNames: ["v"], dependencies: ["ghost-dep"],
        sourceRef: { type: "mission_plan_unit", id: "gate" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => /unresolved dependency/i.test(e) && e.includes("ghost-dep"))).toBe(true);
  });

  it("rejects gate with zero non-gate producer deps", () => {
    const units = [
      { id: "gate1", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: [],
        sourceRef: { type: "mission_plan_unit", id: "gate1" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => e.includes("exactly one non-gate producer"))).toBe(true);
  });

  it("rejects QA missing dependency on a structural gate for its producer", () => {
    const units = [
      { id: "p", kind: "mission_plan_unit", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "p" } },
      { id: "g", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: ["p"],
        sourceRef: { type: "mission_plan_unit", id: "g" } },
      { id: "qa", kind: "mission_plan_unit", title: "[QA] Review", dependsOn: ["p"], // missing "g"
        sourceRef: { type: "mission_plan_unit", id: "qa" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => e.includes("does not depend on structural gate"))).toBe(true);
  });

  it("rejects QA that depends on a gate but omits the gate's producer", () => {
    const units = [
      { id: "p", kind: "mission_plan_unit", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "p" } },
      { id: "g", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: ["p"],
        sourceRef: { type: "mission_plan_unit", id: "g" } },
      { id: "qa", kind: "mission_plan_unit", title: "[QA] Review", dependsOn: ["g"], // omits producer "p"
        sourceRef: { type: "mission_plan_unit", id: "qa" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => e.includes("omits its producer") && e.includes("p"))).toBe(true);
  });

  it("accepts QA that references the producer via a different alias (sourceRef id vs unit id)", () => {
    // Gate references producer by unit id "p"; QA references the same producer
    // by its sourceRef alias "p-src". The resolved producer unit is reachable, so
    // this must NOT be rejected as "omits its producer".
    const units = [
      { id: "p", kind: "mission_plan_unit", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "p-src" } },
      { id: "g", type: "tool", qaType: "structural", toolNames: ["v"], dependsOn: ["p"],
        sourceRef: { type: "mission_plan_unit", id: "g-src" } },
      { id: "qa", kind: "mission_plan_unit", title: "[QA] Review", dependsOn: ["g", "p-src"],
        sourceRef: { type: "mission_plan_unit", id: "qa-src" } },
    ];
    const errors = validateDeclaredStructuralPlan(units);
    expect(errors.some((e) => e.includes("omits its producer"))).toBe(false);
    expect(errors).toEqual([]);
  });

  it("returns no errors when no structural units exist", () => {
    expect(validateDeclaredStructuralPlan([
      { id: "a", title: "Action" },
      { id: "q", title: "[QA] Review", dependsOn: ["a"] },
    ])).toEqual([]);
  });
});

describe("hybrid QA — capability constant", () => {
  it("STRUCTURAL_VALIDATION_CAPABILITY is structural_validation_v1", () => {
    expect(STRUCTURAL_VALIDATION_CAPABILITY).toBe("structural_validation_v1");
  });
});

const support = await getEmbeddedPostgresTestSupport();
const describeEP = support.supported ? describe : describe.skip;
if (!support.supported) {
  console.warn(`Skipping declared-plan readiness tests: ${support.reason ?? "unsupported"}`);
}

// [ purpose ] Pre-PLAN registered-tool readiness (req #4): the SAME readiness
//   applied to persisted runtime gates is applied to DECLARED plan units before
//   PLAN-QA side effects. A plugin-only/unregistered name, a tool missing the
//   structural_validation_v1 capability, or a missing assignee grant must fail.
describeEP("hybrid QA — declared plan readiness (pre-PLAN, registered-tool)", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let companyId: string;
  let agentId: string;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("hybrid-qa-cap-");
    db = createDb(tempDb.connectionString);
    companyId = randomUUID();
    agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Cap Co", status: "active" });
    await db.insert(agents).values({
      id: agentId, companyId, name: "Gate Agent", role: "qa",
      status: "idle", adapterType: "process", adapterConfig: {},
    });
  }, 60_000);
  afterAll(async () => { await tempDb?.cleanup(); });

  async function seedTool(opts: { name: string; capabilities?: string[]; enabled?: boolean; grant?: boolean }) {
    const toolId = randomUUID();
    await db.insert(toolDefinitions).values({
      id: toolId, companyId, name: opts.name, description: "",
      adapterType: "builtin",
      adapterConfig: { capabilities: opts.capabilities ?? [] },
      enabled: opts.enabled ?? true,
    });
    if (opts.grant) {
      await db.insert(agentToolGrants).values({ id: randomUUID(), companyId, agentId, toolId, grantedBy: "test" });
    }
    return toolId;
  }

  const producerUnit = { id: "p", title: "Produce", sourceRef: { type: "mission_plan_unit", id: "p" } };
  const gateUnit = (toolName: string) => ({
    id: "g", type: "tool", qaType: "structural", toolNames: [toolName],
    assigneeAgentId: agentId, dependsOn: ["p"], sourceRef: { type: "mission_plan_unit", id: "g" },
  });

  it("ready gate (registered + enabled + capability + grant) → no errors", async () => {
    await seedTool({ name: "ready-tool", capabilities: [STRUCTURAL_VALIDATION_CAPABILITY], grant: true });
    const errors = await validateDeclaredStructuralPlanReadiness({
      db, companyId, units: [producerUnit, gateUnit("ready-tool")],
    });
    expect(errors).toEqual([]);
  });

  it("unregistered / plugin-only name cannot bypass (no toolDefinitions row)", async () => {
    const errors = await validateDeclaredStructuralPlanReadiness({
      db, companyId, units: [producerUnit, gateUnit("never-registered-tool")],
    });
    expect(errors.some((e) => e.includes("not registered") || e.includes("no toolDefinitions row"))).toBe(true);
  });

  it("tool missing structural_validation_v1 capability is rejected", async () => {
    await seedTool({ name: "no-cap-tool", capabilities: [], grant: true });
    const errors = await validateDeclaredStructuralPlanReadiness({
      db, companyId, units: [producerUnit, gateUnit("no-cap-tool")],
    });
    expect(errors.some((e) => e.includes(STRUCTURAL_VALIDATION_CAPABILITY))).toBe(true);
  });

  it("tool without assignee grant is rejected", async () => {
    await seedTool({ name: "no-grant-tool", capabilities: [STRUCTURAL_VALIDATION_CAPABILITY], grant: false });
    const errors = await validateDeclaredStructuralPlanReadiness({
      db, companyId, units: [producerUnit, gateUnit("no-grant-tool")],
    });
    expect(errors.some((e) => /grant/i.test(e))).toBe(true);
  });

  it("disabled registered tool is rejected", async () => {
    await seedTool({ name: "disabled-tool", capabilities: [STRUCTURAL_VALIDATION_CAPABILITY], enabled: false, grant: true });
    const errors = await validateDeclaredStructuralPlanReadiness({
      db, companyId, units: [producerUnit, gateUnit("disabled-tool")],
    });
    expect(errors.some((e) => /not enabled/i.test(e))).toBe(true);
  });
});
