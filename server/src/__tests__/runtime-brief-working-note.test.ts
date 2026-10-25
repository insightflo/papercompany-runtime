import { describe, expect, it } from "vitest";
import { buildPaperclipRuntimeBrief } from "@paperclipai/adapter-utils";
import { buildMissionWorkingNoteBriefLines } from "@paperclipai/adapter-utils/runtime-brief-working-note";
import {
  buildMissionWorkingNoteContext,
  MISSION_WORKING_NOTE_INSTRUCTIONS,
} from "../services/missions/mission-working-note.js";

// P1/P2 oracle: literal producer contract and renderer at 84eb2d19,
// mission-working-note.ts:22–36 and runtime-brief.ts:727–746.
// Do not import the candidate's shared report string into these expectations.
const EXPECTED_INSTRUCTIONS = [
  "Read this working.md before acting on mission-scoped work.",
  "Update it with mission-relevant current status, evidence, decisions, open questions, and next steps.",
  "When updating, rewrite the sections in place instead of appending; raw logs, chat transcripts, and draft outputs do not belong in this file.",
  "Keep only beliefs, progress, and reusable experience; anything else belongs in run logs, issue comments, or workProducts.",
  "Record each decision with a status (confirmed, under_review, or retired); when a decision replaces an earlier one, keep the old entry retired with a pointer to its replacement.",
  "When citing files as evidence, record the path with a content hash (for example sha256) so later runs can detect stale references.",
  "Report mission-level decisions (new, changed, confirmed, or retired) via POST /api/missions/{missionId}/decision-reports with updates [{id, summary, status, supersedes}]; the mission decision log is the record.",
  "Do not treat working.md as a final deliverable; official outputs must still be registered as workProducts.",
];
const NOTE_PATH = "/paperclip/mission-working-notes/company-1/mission-1/working.md";
const COMPACT_REPORT = "- Mission decision log: report mission-level decisions (new, changed, confirmed, or retired) via POST /api/missions/mission-1/decision-reports with updates [{id, summary, status, supersedes}]; statuses confirmed/under_review/retired; the mission decision log is the record.";
// H1: pin T1 after report deduplication; T2 may change only the header.
const T1_NOTE_HEADER = `- Mission working note: ${NOTE_PATH} (shared scratch context; read before acting, update mission status/evidence/decisions/next steps, not a final workProduct).`;
const T1_NOTE_LINES = [
  T1_NOTE_HEADER,
  ...EXPECTED_INSTRUCTIONS.slice(0, 6).map((line) => `- ${line}`),
  `- ${EXPECTED_INSTRUCTIONS[7]}`,
  COMPACT_REPORT,
];
const NOTE_HEADER = `- Mission working note: ${NOTE_PATH} (shared scratch context).`;
const COMPACT_NOTE_LINES = [
  NOTE_HEADER,
  ...EXPECTED_INSTRUCTIONS.slice(0, 6).map((line) => `- ${line}`),
  `- ${EXPECTED_INSTRUCTIONS[7]}`,
  COMPACT_REPORT,
];

function makeNote(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    available: true, missionId: "mission-1", path: NOTE_PATH, fileName: "working.md",
    role: "shared_mission_working_note", instructions: [...EXPECTED_INSTRUCTIONS], ...overrides,
  };
}

// Pre-T1 renderer; also the unchanged T1 fallback for nonstandard inputs.
function legacyNoteLines(note: Record<string, unknown> | null): string[] {
  const text = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
  const notePath = text(note?.path);
  const missionId = text(note?.missionId);
  if (note?.available !== true || !notePath) return [];
  const instructions = Array.isArray(note.instructions)
    ? note.instructions.filter((line): line is string => typeof line === "string" && line.trim().length > 0)
    : [];
  return [
    `- Mission working note: ${notePath} (shared scratch context; read before acting, update mission status/evidence/decisions/next steps, not a final workProduct).`,
    ...instructions.map((line) => `- ${line}`),
    ...(missionId ? [`- Mission decision log: report mission-level decisions via POST /api/missions/${missionId}/decision-reports with updates [{id, summary, status, supersedes}]; statuses confirmed/under_review/retired.`] : []),
  ];
}

function makeContext(note: Record<string, unknown> | null, missionId: unknown = "mission-1") {
  return {
    missionId,
    paperclipUserFacingLanguage: "ko",
    paperclipStepInputManifest: {
      taskKey: "issue-1",
      inputs: {
        missionWorkingNote: note,
        workspace: { available: true, source: "project", workspaceId: "ws-1" },
        tools: { available: true, names: ["publish"] },
        missionSearch: { allowedScopes: ["mission"] },
        fileViews: { available: true, count: 1, source: "wake_comment" },
      },
      guardrails: { broadScanAllowed: false },
    },
    paperclipIssueExecutionCard: {
      requiredOutputs: {
        workProduct: { required: true, outputDir: "/out/report" },
        verdict: { required: true, ledger: "workflow_validation_verdict", allowed: ["PASS", "REQUEST_CHANGES"] },
      },
      workflow: { stepId: "produce", runId: "run-1", dependencyStepIds: ["collect"], qaType: "security", qaInputScope: "dependency_work_products" },
      toolPermissionContract: { requiredToolNames: ["publish"] },
    },
    paperclipInstructionInjection: { mode: "compact", contentHash: "instructions-1" },
  };
}

// Other sections are fixed base output, including Allowed versus Available tools.
const PREFIX = [
  "Paperclip runtime brief:",
  "Mission Search (server-side scoped discovery — use BEFORE any raw scan):\n\n- Available scopes this run: mission.\n\n- Canonical request, auth, and scope rules live in the Paperclip runtime skill (missionSearch); do not hand-roll a competing curl recipe here.",
  "- User-facing language: write issue descriptions, comments, and operator-facing summaries in ko. Keep tool calls, code, identifiers, JSON, and other machine-facing control-plane data in English.",
  "- Use im-human for new human-facing issue comments and final output; read its bundled SKILL.md and follow company language.",
  "- Task key: issue-1",
  "- Workspace: available (project) [ws-1]",
  "- No runtime service assets are listed in this dossier. This is not a Paperclip worker-runtime health signal.",
  "- Allowed tools: publish",
];
const SUFFIX = [
  "- File views: 1 available (wake_comment)",
  "- Broad scans: disallowed (allowed mission search scopes: mission). Use missionSearch instead of pathless rg/find.",
  "Issue execution card:",
  "- Work product: required=true; outputDir=/out/report",
  "- Verdict: required=true; ledger=workflow_validation_verdict; allowed=PASS, REQUEST_CHANGES",
  "- Workflow API closeout: register artifacts with /workflow/artifacts, submit verdict with /workflow/verdict (+findings on REQUEST_CHANGES), complete with /workflow/complete; use the paperclip skill for request examples.",
  "- Workflow: step=produce, run=run-1; dependsOn=collect",
  "- QA type: security; inputScope=dependency_work_products",
  "- QA input boundary: Use only declared dependency workProduct paths; do not scan the workspace.",
  "- Available tools: publish — use them only when the task needs them; they are not mandatory.",
  "- Agent instructions injection: compact (instructions-1).",
];
const joinBaseLines = (lines: string[]) => lines.map((line) => line.trim()).filter(Boolean).join("\n");

function freezeDeep(value: unknown): void {
  if (typeof value !== "object" || value === null) return;
  Object.values(value).forEach(freezeDeep);
  Object.freeze(value);
}

 describe("mission working-note runtime brief contract", () => {
  it("P1: gives mission-1 one complete report instruction and reduces the frozen baseline", () => {
    const note = makeNote();
    const brief = buildPaperclipRuntimeBrief(makeContext(note));
    const baseline = joinBaseLines([...PREFIX, ...legacyNoteLines(note), ...SUFFIX]);
    expect(brief).toBe(joinBaseLines([...PREFIX, ...COMPACT_NOTE_LINES, ...SUFFIX]));
    expect(baseline.split("decision-reports")).toHaveLength(3);
    expect(brief.split("decision-reports")).toHaveLength(2);
    expect(brief).not.toContain("/api/missions/{missionId}/decision-reports");
    expect(brief).toContain(COMPACT_REPORT);
    expect(brief.length).toBeLessThan(baseline.length);
    expect(buildMissionWorkingNoteBriefLines(note, ["mission-1"])).toEqual(COMPACT_NOTE_LINES);
  });

  it("H1: shortens only the T1 header and preserves every detailed instruction", () => {
    const note = makeNote();
    const lines = buildMissionWorkingNoteBriefLines(note, ["mission-1"]);
    const brief = buildPaperclipRuntimeBrief(makeContext(note));
    const baseline = joinBaseLines([...PREFIX, ...T1_NOTE_LINES, ...SUFFIX]);
    expect(lines[0]).toBe(NOTE_HEADER);
    expect(lines[0].length).toBeLessThan(T1_NOTE_HEADER.length);
    expect(lines.slice(1)).toEqual(T1_NOTE_LINES.slice(1));
    expect(brief.replace(NOTE_HEADER, T1_NOTE_HEADER)).toBe(baseline);
    expect(baseline.length - brief.length).toBe(T1_NOTE_HEADER.length - NOTE_HEADER.length);
  });

  const fallbacks: Array<[string, Record<string, unknown> | null, unknown]> = [
    ["missing read", makeNote({ instructions: EXPECTED_INSTRUCTIONS.filter((_, i) => i !== 0) }), "mission-1"],
    ["variant read", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 0 ? line.replace("before acting", "after acting") : line) }), "mission-1"],
    ["missing update", makeNote({ instructions: EXPECTED_INSTRUCTIONS.filter((_, i) => i !== 1) }), "mission-1"],
    ["variant update", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 1 ? line.replace("Update it", "Do not update it") : line) }), "mission-1"],
    ["missing not-deliverable", makeNote({ instructions: EXPECTED_INSTRUCTIONS.filter((_, i) => i !== 7) }), "mission-1"],
    ["variant not-deliverable", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 7 ? line.replace("Do not treat", "Treat") : line) }), "mission-1"],
    ["custom report", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 6 ? "Report only after operator approval." : line) }), "mission-1"],
    ["custom addition", makeNote({ instructions: [...EXPECTED_INSTRUCTIONS, "Ask before publishing."] }), "mission-1"],
    ["legacy partial list", makeNote({ instructions: EXPECTED_INSTRUCTIONS.slice(0, 3) }), "mission-1"],
    ["variant report", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 6 ? line.replace("new, changed", "new/changed") : line) }), "mission-1"],
    ["padded report", makeNote({ instructions: EXPECTED_INSTRUCTIONS.map((line, i) => i === 6 ? ` ${line} ` : line) }), "mission-1"],
    ["missing report", makeNote({ instructions: EXPECTED_INSTRUCTIONS.filter((_, i) => i !== 6) }), "mission-1"],
    ["duplicate report", makeNote({ instructions: [...EXPECTED_INSTRUCTIONS, EXPECTED_INSTRUCTIONS[6]] }), "mission-1"],
    ["reordered list", makeNote({ instructions: [...EXPECTED_INSTRUCTIONS].reverse() }), "mission-1"],
    ["missing instructions", makeNote({ instructions: undefined }), "mission-1"],
    ["non-array instructions", makeNote({ instructions: EXPECTED_INSTRUCTIONS[6] }), "mission-1"],
    ["filtered entries", makeNote({ instructions: [null, 7, "", ...EXPECTED_INSTRUCTIONS] }), "mission-1"],
    ["unavailable note", makeNote({ available: false }), "mission-1"],
    ["missing path", makeNote({ path: undefined }), "mission-1"],
    ["blank path", makeNote({ path: "  " }), "mission-1"],
    ["non-string path", makeNote({ path: 7 }), "mission-1"],
    ["missing mission", makeNote({ missionId: undefined }), "mission-1"],
    ["padded mission", makeNote({ missionId: " mission-1 " }), "mission-1"],
    ["mission mismatch", makeNote({ missionId: "mission-2" }), "mission-1"],
    ["missing request scope despite mission path", makeNote(), undefined],
    ["null request scope", makeNote(), null],
    ["conflicting request scope", makeNote(), "mission-2"],
    ["non-string request scope", makeNote(), 7],
    ["missing note", null, "mission-1"],
  ];
  it.each(fallbacks)("P2: preserves exact legacy output for %s", (_label, note, missionId) => {
    const context = makeContext(note);
    context.missionId = missionId;
    expect(buildMissionWorkingNoteBriefLines(note, [missionId])).toEqual(legacyNoteLines(note));
    expect(buildPaperclipRuntimeBrief(context)).toBe(joinBaseLines([...PREFIX, ...legacyNoteLines(note), ...SUFFIX]));
  });

  it("P2: requires agreement of all supplied structured scopes, without inferring from paths", () => {
    const note = makeNote();
    expect(buildMissionWorkingNoteBriefLines(note, [])).toEqual(legacyNoteLines(note));
    expect(buildMissionWorkingNoteBriefLines(note, ["mission-1", "mission-2"])).toEqual(legacyNoteLines(note));
    const context = makeContext(note);
    const inputs: Record<string, unknown> = context.paperclipStepInputManifest.inputs;
    inputs.missionOwnerPlanningContext = { available: true, missionId: "mission-2" };
    const brief = buildPaperclipRuntimeBrief(context);
    expect(brief).toContain(legacyNoteLines(note).join("\n"));
    expect(brief).not.toContain(COMPACT_REPORT);
    inputs.missionOwnerPlanningContext = { available: true, missionId: "mission-1" };
    expect(buildPaperclipRuntimeBrief(context)).toContain(COMPACT_NOTE_LINES.join("\n"));
    context.missionId = undefined;
    expect(buildPaperclipRuntimeBrief(context)).toContain(COMPACT_NOTE_LINES.join("\n"));
  });

  it("P2: retains producer bytes, ordering, shared array, and frozen input", () => {
    const expectedBytes = Buffer.from(JSON.stringify(EXPECTED_INSTRUCTIONS), "utf8");
    const producer = buildMissionWorkingNoteContext({ missionId: "mission-1", path: NOTE_PATH });
    expect(Buffer.from(JSON.stringify(producer.instructions), "utf8")).toEqual(expectedBytes);
    expect(producer.instructions).toBe(MISSION_WORKING_NOTE_INSTRUCTIONS);
    expect(buildMissionWorkingNoteBriefLines(producer, ["mission-1"])).toEqual(COMPACT_NOTE_LINES);
    const context = makeContext(makeNote());
    const before = JSON.stringify(context);
    freezeDeep(context);
    buildPaperclipRuntimeBrief(context);
    buildMissionWorkingNoteBriefLines(context.paperclipStepInputManifest.inputs.missionWorkingNote, ["mission-1"]);
    expect(JSON.stringify(context)).toBe(before);
    expect(Buffer.from(JSON.stringify(MISSION_WORKING_NOTE_INSTRUCTIONS), "utf8")).toEqual(expectedBytes);
  });

  it("P2: preserves the antigravity wrapper without unwrapping nested context", () => {
    expect(buildPaperclipRuntimeBrief({ agent: {}, runtime: {}, context: makeContext(makeNote()) })).toBe([
      "- Use im-human for new human-facing issue comments and final output; read its bundled SKILL.md and follow company language.",
      "- Workspace: unavailable",
      "- No runtime service assets are listed in this dossier. This is not a Paperclip worker-runtime health signal.",
    ].join("\n"));
  });

  it("H2: retains working-note guidance for issue-less mission supervision", () => {
    const brief = buildPaperclipRuntimeBrief({
      missionId: "mission-1",
      paperclipStepInputManifest: { inputs: { missionWorkingNote: makeNote() } },
    });
    expect(brief).toBe([
      PREFIX[3],
      "- Workspace: unavailable",
      PREFIX[6],
      ...COMPACT_NOTE_LINES,
    ].join("\n"));
  });

  it("P2: keeps fresh-session rework, operator priority, closeout ban, artifacts and QA unchanged", () => {
    const context = {
      ...makeContext(makeNote()),
      paperclipPreviousSessionId: "old-session",
      paperclipSessionHandoff: { previousSessionId: "old-session", rotationReason: "budget", lastRunSummaryText: "Repair report" },
      paperclipOperatorInstructionsUnconsumed: [{ id: "op-1", createdAt: "2026-10-25T00:00:00Z", body: "Stop scanning; fix the report." }],
      paperclipIssueRecentComments: [{ id: "comment-1", body: "suppressed-recent-comment" }],
      paperclipWorkflowReworkContract: {
        kind: "workflow_qa_rework", producerStepId: "produce", iterationLabel: "2/2",
        requiredActions: ["Fix output."], producerIssueInstruction: "Produce the report.",
        producerWorkProducts: [{ title: "report-v1", ref: "/out/report.html" }],
        dependencyArtifacts: "- source: /out/source.json",
        qaFeedbacks: [{ qaStepId: "qa", qaIssueId: "Q-1", feedback: "REQUEST_CHANGES: missing evidence." }],
      },
    };
    const priority = [
      "Unconsumed operator instructions (highest priority — apply before other work):",
      "- [2026-10-25T00:00:00Z] Stop scanning; fix the report.",
      "=== CURRENT REWORK TASK (highest priority — resolve before anything else) ===",
      "- Target step: produce | iteration 2/2",
      "- Latest QA failure (qa Q-1): REQUEST_CHANGES: missing evidence.",
      "- Required: Fix output.",
      "- Original instruction: Produce the report.",
      "- Own prior products: report-v1→/out/report.html",
      "- Dependency artifacts: - source: /out/source.json",
      "- FORBIDDEN: do NOT call /workflow/complete or mark done until the REQUEST_CHANGES above is resolved and the artifact is updated or re-registered.",
      "=== end rework task ===",
    ];
    const detail = [
      "Workflow rework contract:",
      "- Rework target: produce (2/2)",
      "- Current run priority: resolve the latest REQUEST_CHANGES below before registering artifacts or completing the issue.",
      "- Required: Fix output.",
      "- Original issue instruction: Produce the report.",
      "- Your prior work products on this issue (verify, update, or re-register):",
      "- report-v1 → /out/report.html",
      "- QA feedback 1: qa (Q-1)",
      "REQUEST_CHANGES: missing evidence.",
      "- Current dependency artifacts:",
      "- source: /out/source.json",
    ];
    const handoff = ["- Previous session: old-session", "- Rotation reason: budget", "- Last run summary: Repair report"];
    const brief = buildPaperclipRuntimeBrief(context);
    expect(brief).toBe([
      PREFIX[0], ...priority, ...PREFIX.slice(1), ...COMPACT_NOTE_LINES, ...detail, ...SUFFIX, ...handoff,
    ].join("\n"));
    expect(brief).not.toContain("suppressed-recent-comment");
  });
});
