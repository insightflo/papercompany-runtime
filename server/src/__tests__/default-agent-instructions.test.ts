import { describe, expect, it } from "vitest";
import {
  loadDefaultAgentInstructionsBundle,
  resolveDefaultAgentInstructionsBundleRole,
} from "../services/default-agent-instructions.js";

describe("default agent instructions bundle", () => {
  it("resolves bundle roles for default and ceo agents", () => {
    expect(resolveDefaultAgentInstructionsBundleRole("member")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("qa")).toBe("default");
    expect(resolveDefaultAgentInstructionsBundleRole("ceo")).toBe("ceo");
  });

  it("includes the SKILL.state working-state pattern in the default AGENTS.md", async () => {
    const files = await loadDefaultAgentInstructionsBundle("default");
    const agentsMd = files["AGENTS.md"] ?? "";

    // [SKILL.state] 장기 과제는 대화가 아니라 상태파일이 그릇 — 재개 시 상태 먼저 읽기.
    expect(agentsMd).toContain("## Working State");
    expect(agentsMd).toContain("state file");
    expect(agentsMd).toMatch(/read(?:ing)? the state file first/i);
    // 선별 보존: 믿음/진척/경험 아니면 로그로.
    expect(agentsMd).toMatch(/not a belief, progress, or reusable experience/i);
    // 결정 지위: confirmed / under_review / retired.
    expect(agentsMd).toMatch(/confirmed\s*\/\s*under_review\s*\/\s*retired/);
    // 산출물은 상태파일이 아니라 컨트롤 플레인으로 보고.
    expect(agentsMd).toMatch(/issue comment/i);
  });

  it("keeps the ceo bundle untouched by the default working-state section", async () => {
    const files = await loadDefaultAgentInstructionsBundle("ceo");
    expect(Object.keys(files).sort()).toEqual(["AGENTS.md", "HEARTBEAT.md", "SOUL.md", "TOOLS.md"]);
    // CEO는 para-memory-files 기반 자체 상태 규율을 사용하므로 기본 Working State 섹션을 주입하지 않는다.
    expect(files["AGENTS.md"]).not.toContain("## Working State");
  });
});
