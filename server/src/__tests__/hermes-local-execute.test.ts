import { describe, expect, it } from "vitest";

import {
  buildHermesChatArgs,
  formatHermesTimeoutLabel,
  parseHermesOutput,
} from "../adapters/hermes-local-execute.js";

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
});
