import { afterAll, beforeAll, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { companyKnowledgePatterns, issues, missions, toolDefinitions, workflowRuns, workflowStepRuns } from "@paperclipai/db";
import { createQualityTestDb, describeQualityDb } from "./helpers/quality-db.js";
import { seedToolRecoveryScenario } from "./helpers/tool-recovery-scenario.js";
import { rmSync } from "node:fs";
import { loadToolRecoveryBriefFacts } from "../services/missions/tool-recovery-brief-facts.js";
import { renderToolRecoveryBriefFacts } from "../services/missions/tool-recovery-brief-render.js";
import { buildToolStepRecoveryDescription } from "../services/missions/tool-step-recovery-description.js";
import { classifyToolStepFailure } from "../services/missions/tool-step-failure.js";
import { missionOwnerDecisionSubmitSchema } from "@paperclipai/shared";

// Catches decision drift, false actor authority and config/diagnostic leakage.
describeQualityDb("brief boundaries and accepted decision matrix", () => {
  let f: Awaited<ReturnType<typeof createQualityTestDb>>;
  const roots: string[] = [];
  beforeAll(async () => { f = await createQualityTestDb(); }, 60_000);
  afterAll(async () => { await f?.close(); roots.forEach(root => rmSync(root, { recursive: true, force: true })); });
  async function input() {
    const s = await seedToolRecoveryScenario({ db: f.db, artifactExists: false }); roots.push(s.tempRoot);
    const [mission] = await f.db.select().from(missions).where(eq(missions.id, s.missionId));
    const [oversightIssue] = await f.db.select().from(issues).where(eq(issues.id, s.oversightIssueId));
    const [run] = await f.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.workflowRunId));
    const [stepRun] = await f.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.stepRunId));
    return { mission, oversightIssue, run, stepRun, step: null, workflowName: "test" };
  }
  it("all nine accepted options distinguish recorded intent from direct effects and operator authority", async () => {
    const i = await input();
    const facts = await f.db.transaction(tx => loadToolRecoveryBriefFacts(tx as never, i));
    expect(facts.decisions.map(d => [d.decision, d.effect, d.humanRequest, Boolean(d.replacement)])).toEqual([
      ["request_input", "no_tool_action", true, false], ["retry_source_issue", "retry", false, false],
      ["reassign_source_issue", "no_tool_action", false, false], ["replan_mission", "no_tool_action", false, false],
      ["restart_from_start", "no_tool_action", false, true], ["escalate", "no_tool_action", true, false],
      ["report_impossible", "no_tool_action", false, false], ["recover_artifact", "artifact", false, false],
      ["no_action_waiting", "no_tool_action", false, false],
    ]);
    for (const row of facts.decisions) expect(missionOwnerDecisionSubmitSchema.safeParse({ decision: row.decision,
      ...(row.decision === "reassign_source_issue" ? { targetAgentId: i.mission.ownerAgentId } : {}) }).success).toBe(true);
    expect(facts.execution.status).toBe("requires_decision");
    expect(facts.execution.ownership).toBe(false); // missing frozen definition is NOT permissive
    expect(facts.execution.canonicalToolShape).toBe("unavailable");
    expect(facts.registration.status).toBe("registration_not_applicable");
    expect(facts.submission.unchecked).toContain("checkout ownership/adoption");
    expect(facts.submission.actor).toContain("board cannot submit");
  });
  it("shows only related same-company titles/ids and bounded reference content", async () => {
    const i = await input();
    const foreign = await input();
    const [pattern] = await f.db.insert(companyKnowledgePatterns).values({ companyId: i.mission.companyId, kind: "failure_mode", source: "operator",
      title: "tool recovery result", summary: "BODY_SENTINEL", symptoms: "BODY_SENTINEL", rootCause: "BODY_SENTINEL",
      whatWorked: "BODY_SENTINEL", scopeTags: ["tool"], status: "active" }).returning();
    await f.db.insert(companyKnowledgePatterns).values({ companyId: foreign.mission.companyId, kind: "failure_mode", source: "operator",
      title: "FOREIGN_PATTERN tool", summary: "foreign", status: "active", scopeTags: ["tool"] });
    const facts = await f.db.transaction(tx => loadToolRecoveryBriefFacts(tx as never, i));
    expect(facts.relatedPatterns).toEqual([{ id: pattern.id, title: "tool recovery result" }]);
    expect(renderToolRecoveryBriefFacts(facts)).not.toMatch(/BODY_SENTINEL|FOREIGN_PATTERN/);
  });
  it("does not leak quoted JSON diagnostics, config credentials or unbounded instruction text", async () => {
    const i = await input();
    const step = { id: i.stepRun.stepId, name: "tool", dependencies: [], agentId: "", toolNames: ["tool"] };
    await f.db.insert(toolDefinitions).values({ companyId: i.mission.companyId, name: "tool", adapterType: "builtin",
      adapterConfig: { command: "node /tools/run.mjs", env: { API_TOKEN: "KNOWN_SECRET", ROOT: "HIDDEN_ROOT" },
        instructions: "I".repeat(20_000) } });
    i.stepRun.metadata = { toolResult: { stdout: '{"password":"UNKNOWN_SECRET"}', stderr: 'token="QUOTED SECRET" KNOWN_SECRET HIDDEN_ROOT' } };
    const facts = await f.db.transaction(tx => loadToolRecoveryBriefFacts(tx as never, { ...i, step }));
    const text = buildToolStepRecoveryDescription({ marker: "test", missionTitle: i.mission.title, workflowName: i.workflowName,
      workflowRunId: i.run.id, stepId: i.stepRun.stepId, displayStepName: "tool", toolNames: ["tool"],
      classification: classifyToolStepFailure(step, i.stepRun), facts });
    expect(text).not.toMatch(/KNOWN_SECRET|HIDDEN_ROOT|UNKNOWN_SECRET|QUOTED SECRET/);
    expect(text.length).toBeLessThan(20_000);
  });
});
