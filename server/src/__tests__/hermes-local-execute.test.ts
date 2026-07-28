import { describe, expect, it } from "vitest";

import {
  buildHermesChatArgs,
  buildHermesResultJson,
  deriveHermesRunKind,
  formatHermesTimeoutLabel,
  HERMES_OPERATIONS_LIAISON_BRIEF,
  parseHermesOutput,
  parseHermesProgressText,
} from "../adapters/hermes-local-execute.js";

// [목적] Hermes Ops liaison default brief가 operational monitoring MVP 규칙을
//   source-level로 포함하는지 검증. 이 brief는 모든 liaison agent runtime에
//   prepend되므로(기존/신규 agent, DB config 무관), source 기본값이 곧 동작 기본값이다.
describe("Hermes Ops liaison default brief (operational monitoring MVP)", () => {
  const brief = HERMES_OPERATIONS_LIAISON_BRIEF;

  it("includes the active-mission monitoring checklist for timer/heartbeat runs", () => {
    expect(brief).toMatch(/Operational Monitoring Protocol/i);
    expect(brief).toMatch(/read-only/i);
    expect(brief).toContain("GET /api/companies/:companyId/missions?status=active");
    expect(brief).toContain("GET /api/companies/:companyId/missions?status=planning");
    expect(brief).toMatch(/active\/running\/planning/i);
  });

  it("routes no-active-run handoff to the supervision-run endpoint FIRST", () => {
    expect(brief).toContain("POST /api/companies/:companyId/missions/:missionId/supervision/run");
    expect(brief).toMatch(/FIRST CHOICE/i);
  });

  it("uses POST issue comments as the fallback handoff and forbids PATCH", () => {
    expect(brief).toContain("POST /api/issues/:id/comments");
    expect(brief).toMatch(/Do NOT use PATCH/i);
  });

  it("keeps maxConcurrentRuns at 1 and monitoring runs short", () => {
    expect(brief).toMatch(/maxConcurrentRuns at 1/);
  });

  it("encodes a 30-minute per-mission dedup with a stuck marker", () => {
    expect(brief).toMatch(/30 minutes/);
    expect(brief).toContain("<!-- hermes-ops-stuck-monitor:{missionId}:{YYYY-MM-DDTHH} -->");
  });

  it("marks heartbeat.mission_run_active stuck-but-active as report-only (needs code)", () => {
    expect(brief).toMatch(/heartbeat\.mission_run_active/);
    expect(brief).toMatch(/Report-only/);
  });

  // [주의 — P0b/P0c] brief와 서버 denylist(hermes-ops-mutation-guard)의 operational 일치를 lock.
  //   liaison 에이전트는 issueId 무관하게 이 brief를 받으므로(-q prompt), brief가 mutation 금지를
  //   안내하면 Hermes가 불필요한 403 시도를 줄인다. 이 매핑이 깨지면 guard는 있지만 Hermes가 모름.
  it("documents the server-side denylist so liaison runs do not attempt blocked mutations", () => {
    expect(brief).toMatch(/hermes_ops_mutation_forbidden/);
    expect(brief).toMatch(/HTTP 403/);
  });

  it("requires durable target-state evidence before claiming an action succeeded", () => {
    expect(brief).toMatch(/new durable Paperclip record/);
    expect(brief).toMatch(/A Hermes chat wakeup\/run proves only that Hermes answered/);
    expect(brief).toMatch(/workflow step status and validation verdict\/request_changes are state authority/);
    expect(brief).toMatch(/plain issue comment on a done issue is not execution/);
    expect(brief).toMatch(/reopen:true/);
    expect(brief).toMatch(/agent_wakeup_requests/);
  });
});

describe("hermes local execution config", () => {
  it("streams Hermes output to Paperclip by default", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "gpt-5.5",
      provider: "openai-codex",
    });

    expect(args).toEqual([
      "chat",
      "-q",
      "Do the work",
      "-m",
      "gpt-5.5",
      "--provider",
      "openai-codex",
      "-v",
    ]);
    expect(args).not.toContain("-Q");
  });

  it("passes Xiaomi/MiMo provider through to Hermes CLI", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "mimo-v2.5-pro",
      provider: "xiaomi",
    });

    expect(args).toEqual(
      expect.arrayContaining(["-m", "mimo-v2.5-pro", "--provider", "xiaomi"]),
    );
  });
  it("passes xAI OAuth provider through to Hermes CLI", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "grok-4",
      provider: "xai-oauth",
    });

    expect(args).toEqual(
      expect.arrayContaining(["-m", "grok-4", "--provider", "xai-oauth"]),
    );
  });

  it("passes image attachments and tool auto-approval flags through to Hermes CLI", () => {
    const args = buildHermesChatArgs({
      prompt: "Inspect this image",
      model: "gpt-5.5",
      provider: "openai-codex",
      imagePaths: ["/tmp/screenshot.png"],
      yolo: true,
    });

    expect(args).toEqual(
      expect.arrayContaining(["--image", "/tmp/screenshot.png", "--yolo"]),
    );
  });

  it("keeps quiet mode available as an explicit opt-in", () => {
    const args = buildHermesChatArgs({
      prompt: "Do the work",
      model: "gpt-5.5",
      quiet: true,
      verbose: true,
    });

    expect(args).toContain("-Q");
    expect(args).not.toContain("-v");
  });

  it("preserves resume and caller-provided extra args", () => {
    const args = buildHermesChatArgs({
      prompt: "Continue",
      model: "gpt-5.5",
      persistSession: true,
      prevSessionId: "session-123",
      extraArgs: ["--max-turns", "40"],
    });

    expect(args).toContain("--resume");
    expect(args).toContain("session-123");
    expect(args.slice(-2)).toEqual(["--max-turns", "40"]);
  });

  it("shows disabled idle timeout explicitly in run logs", () => {
    expect(
      formatHermesTimeoutLabel({ timeoutSec: 240, idleTimeoutSec: 0 }),
    ).toBe("timeout=240s, idleTimeout=disabled");
    expect(
      formatHermesTimeoutLabel({ timeoutSec: 240, idleTimeoutSec: 75 }),
    ).toBe("timeout=240s, idleTimeout=75s");
  });

  it("extracts user-facing progress while hiding tool calls and results", () => {
    const progress = parseHermesProgressText(
      [
        "Query: Paperclip runtime brief:",
        "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
        "    알겠습니다. 구조를 확인하고 영향도를 파악하겠습니다.",
        "    먼저 workflow step 정의를 확인하겠습니다.",
        "    📞 Tool 1: terminal",
        "    Args: {\"command\":\"rg -n generate-infographic server\"}",
        "    ✅ Tool 1 completed in 0.09s",
        "    Result: {\"output\":\"server/src/workflows.ts:12\", \"exit_code\": 0}",
        "    curl -s -H \"$AUTH\" \"http://localhost:3200/api/workflows/workflow-1\" | jq '.. | strings'",
        "    -iE \"만화|comic|PNG\"",
        "    다음으로 참조를 제거하고 테스트하겠습니다.",
        "╰──────────────────────────────────────────────────────────────────────────────╯",
      ].join("\n"),
    );

    expect(progress).toContain("알겠습니다. 구조를 확인하고 영향도를 파악하겠습니다.");
    expect(progress).toContain("먼저 workflow step 정의를 확인하겠습니다.");
    expect(progress).toContain("다음으로 참조를 제거하고 테스트하겠습니다.");
    expect(progress).not.toContain("rg -n generate-infographic");
    expect(progress).not.toContain("server/src/workflows.ts");
    expect(progress).not.toContain("curl -s");
    expect(progress).not.toContain("jq '.. | strings'");
  });

  it("extracts the assistant response and session id from Hermes transcript output", () => {
    const parsed = parseHermesOutput(
      [
        "Query: Paperclip runtime brief:",
        "Initializing agent...",
        "Conversation completed after 1 OpenAI-compatible API call(s)",
        "    draft text before final speaker label",
        "    ⚕ Hermes",
        "    현재 Hermes web chat 세션 session-1 를 인식했습니다.",
        "Resume this session with:",
        "  hermes --resume 20260609_104628_73500a",
        "",
        "Session:        20260609_104628_73500a",
      ].join("\n"),
      "",
    );

    expect(parsed.response).toBe("현재 Hermes web chat 세션 session-1 를 인식했습니다.");
    expect(parsed.sessionId).toBe("20260609_104628_73500a");
  });

  it("prefers the full Hermes assistant block before the completion marker over the trailing recap line", () => {
    const parsed = parseHermesOutput(
      [
        "Query: Paperclip runtime brief:",
        "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
        "  ✅ Tool 1 completed in 0.09s",
        "     Result: {\"output\":\"/Users/kwak/Downloads/report.html exists\", \"exit_code\": 0}",
        "    현재 상태:",
        "    리서치 본작업과 QA 워크플로우는 끝났고, 검증 결과도 PASS까지 나왔습니다.",
        "    ",
        "    증거 기준으로 정리하면:",
        "    - RES-974: 처음에는 REQUEST_CHANGES였지만 이후 QA Verdict: PASS.",
        "    - RES-979: 최종 QA PASS.",
        "    ",
        "    추천 다음 액션:",
        "    1. RES-975 in_review 종결 여부를 결정.",
        "🎉 Conversation completed after 14 OpenAI-compatible API call(s)",
        "    제가 지금 임의로 완료 처리하지는 않았습니다.",
        "╰──────────────────────────────────────────────────────────────────────────────╯",
        "Resume this session with:",
        "  hermes --resume 20260609_121523_a6478b",
        "",
        "Session:        20260609_121523_a6478b",
      ].join("\n"),
      "",
    );

    expect(parsed.response).toContain("현재 상태:");
    expect(parsed.response).toContain("RES-974: 처음에는 REQUEST_CHANGES");
    expect(parsed.response).toContain("추천 다음 액션:");
    expect(parsed.response).not.toBe("제가 지금 임의로 완료 처리하지는 않았습니다.");
    expect(parsed.sessionId).toBe("20260609_121523_a6478b");
  });

  it("prefers the final Hermes block after the completion marker over a preceding reasoning summary", () => {
    const parsed = parseHermesOutput(
      [
        "┌─ Reasoning ──────────────────────────────────────────────────────────────────┐",
        "Good. The grep exit code 1 means no matches found, which is what we want. Let me summarize",
        "🎉 Conversation completed after 25 OpenAI-compatible API call(s)",
        " the changes.",
        "└──────────────────────────────────────────────────────────────────────────────┘",
        "",
        "╭─ ⚕ Hermes ───────────────────────────────────────────────────────────────────╮",
        "    완료. 두 워크플로우 모두 수정했습니다.",
        "    ",
        "    tech-scout (8 steps → 6 steps):",
        "    - 제거: generate-infographic (Tech Scout 교육만화 생성)",
        "    - 제거: validate-artifact (Tech Scout 산출물 검증) — 만화 산출물 전용 검증",
        "    - 수정: send-telegram 의존 변경 → lead-approval 직접 연결, 이름/설명에서 \"PNG\" 제거",
        "    ",
        "    tech-ai-news (7 steps → 5 steps):",
        "    - 제거: generate-infographic (Generate TechCrunch AI educational comic)",
        "    - 제거: validate-ai-news-artifact (Validate TechCrunch AI artifact) — 만화 산출물 전용 검증",
        "    - 수정: send-telegram 의존 변경 → lead-ai-news-approval 직접 연결",
        "╰──────────────────────────────────────────────────────────────────────────────╯",
        "",
        "Resume this session with:",
        "  hermes --resume 20260619_080911_55a9e8",
        "",
        "Session:        20260619_080911_55a9e8",
      ].join("\n"),
      "",
    );

    expect(parsed.response).toContain("완료. 두 워크플로우 모두 수정했습니다.");
    expect(parsed.response).toContain("tech-scout (8 steps → 6 steps):");
    expect(parsed.response).toContain("tech-ai-news (7 steps → 5 steps):");
    expect(parsed.response).not.toContain("Good. The grep exit code");
    expect(parsed.sessionId).toBe("20260619_080911_55a9e8");
  });
});

describe("hermes run-kind + resultJson recovery advice (P4)", () => {
  it("deriveHermesRunKind: chat from paperclipHermesChat, monitor only for liaison, null otherwise", () => {
    expect(deriveHermesRunKind({ paperclipHermesChat: { source: "paperclip_ui" }, isOperationsLiaison: false })).toBe("chat-sidebar");
    expect(deriveHermesRunKind({ paperclipHermesChat: { source: "telegram" }, isOperationsLiaison: false })).toBe("chat-telegram");
    // chat context without source -> sidebar default
    expect(deriveHermesRunKind({ paperclipHermesChat: {}, isOperationsLiaison: false })).toBe("chat-sidebar");
    // no chat + liaison -> monitor
    expect(deriveHermesRunKind({ paperclipHermesChat: null, isOperationsLiaison: true })).toBe("monitor");
    expect(deriveHermesRunKind({ paperclipHermesChat: undefined, isOperationsLiaison: true })).toBe("monitor");
    // [scope bug fix] no chat + non-liaison -> null (general hermes_local executor run is not Hermes Ops)
    expect(deriveHermesRunKind({ paperclipHermesChat: null, isOperationsLiaison: false })).toBeNull();
  });

  it("buildHermesResultJson: writes hermesRunKind + base fields, omits recoveryAdvice when absent", () => {
    const json = buildHermesResultJson({
      result: "answer",
      sessionId: "sess-1",
      usage: { input: 10 },
      costUsd: 0.01,
      paperclipHermesChat: { source: "telegram" },
      isOperationsLiaison: false,
    });
    expect(json.hermesRunKind).toBe("chat-telegram");
    expect(json.result).toBe("answer");
    expect(json.session_id).toBe("sess-1");
    expect(json.cost_usd).toBe(0.01);
    // [주의] advice 없으면 key 자체가 없어야.
    expect(json.recoveryAdvice).toBeUndefined();
  });

  it("buildHermesResultJson: nests recoveryAdvice and NEVER adds top-level decision", () => {
    const advice = {
      missionId: "m1",
      selectedIssueId: null,
      decision: "producer_rework",
      targetIssue: { id: "p1", identifier: "RES-1076", title: "x", role: "producer", assigneeAgentId: null },
      targetAction: "rework",
      leafCause: "missing source",
      evidence: [],
      operatorComment: "재작성 요청",
      doNot: [],
      missingEvidence: [],
    };
    const json = buildHermesResultJson({
      result: "answer",
      sessionId: null,
      usage: null,
      costUsd: null,
      paperclipHermesChat: { source: "paperclip_ui", recoveryAdvice: advice },
      isOperationsLiaison: false,
    });
    // [P4 invariant -- verdict reader 충돌 방지] nested ONLY, top-level decision 금지.
    expect(json.recoveryAdvice).toEqual(advice);
    expect(json).not.toHaveProperty("decision");
    expect(json.hermesRunKind).toBe("chat-sidebar");
  });

  it("buildHermesResultJson: monitor run for liaison (no paperclipHermesChat)", () => {
    const json = buildHermesResultJson({
      result: "monitor sweep",
      sessionId: null,
      usage: null,
      costUsd: null,
      paperclipHermesChat: null,
      isOperationsLiaison: true,
    });
    expect(json.hermesRunKind).toBe("monitor");
    expect(json.recoveryAdvice).toBeUndefined();
  });

  it("buildHermesResultJson: non-liaison hermes_local run without chat omits hermesRunKind entirely", () => {
    const json = buildHermesResultJson({
      result: "executor work",
      sessionId: null,
      usage: null,
      costUsd: null,
      paperclipHermesChat: null,
      isOperationsLiaison: false,
    });
    // [scope bug fix] general hermes_local executor run은 Hermes Ops가 아니므로 kind를 쓰지 않는다.
    expect(json).not.toHaveProperty("hermesRunKind");
    expect(json.result).toBe("executor work");
  });
});
