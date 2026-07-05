import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { evaluateContextBudgetPreflight } from "../services/context-budget-preflight.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("context budget instruction injection policy", () => {
  it("estimates compact repeated instructions instead of the full file body", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-compact-instructions-"));
    tempDirs.push(dir);
    const instructionsPath = path.join(dir, "AGENTS.md");
    await fs.writeFile(instructionsPath, "FULL_BODY_".repeat(20_000), "utf8");

    const full = await evaluateContextBudgetPreflight({
      runtimeConfig: { heartbeat: { contextBudgetPreflight: { maxEstimatedTokens: 20_000 } } },
      adapterType: "codex_local",
      adapterConfig: { instructionsFilePath: instructionsPath, promptTemplate: "Run." },
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
      context: {},
      hasResumableSession: true,
      cwd: dir,
    });
    const compact = await evaluateContextBudgetPreflight({
      runtimeConfig: { heartbeat: { contextBudgetPreflight: { maxEstimatedTokens: 20_000 } } },
      adapterType: "codex_local",
      adapterConfig: { instructionsFilePath: instructionsPath, promptTemplate: "Run." },
      agent: { id: "agent-1", companyId: "company-1", name: "Agent" },
      runId: "run-1",
      context: {
        paperclipInstructionInjection: {
          mode: "compact",
          contentHash: "abc123",
        },
      },
      hasResumableSession: true,
      cwd: dir,
    });

    expect(full.estimate.instructionsChars).toBeGreaterThan(100_000);
    expect(compact.estimate.instructionsChars).toBeLessThan(500);
    expect(compact.blocked).toBe(false);
  });
});
