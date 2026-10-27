import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { execute as executeClaude } from "@paperclipai/adapter-claude-local/server";
import { execute as executeCodex } from "@paperclipai/adapter-codex-local/server";
import { execute as executeCommandCode } from "@paperclipai/adapter-commandcode-local/server";
import { execute as executeCursor } from "@paperclipai/adapter-cursor-local/server";
import { execute as executeGemini } from "@paperclipai/adapter-gemini-local/server";
import { execute as executeOpenCode } from "@paperclipai/adapter-opencode-local/server";
import { execute as executePi } from "@paperclipai/adapter-pi-local/server";
import {
  hashLoadedInstructions,
  loadInstructionsWithInlinedReferences,
} from "@paperclipai/adapter-utils/instructions";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

type Adapter = "claude" | "codex" | "commandcode" | "cursor" | "gemini" | "opencode" | "pi";

async function fixture(adapter: Adapter) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-${adapter}-instruction-fallback-`));
  tempDirs.push(root);
  const cwd = path.join(root, "workspace");
  const command = path.join(root, adapter);
  const attemptsPath = path.join(root, "attempts.jsonl");
  const instructionsFilePath = path.join(root, "AGENTS.md");
  await fs.mkdir(cwd, { recursive: true });
  await fs.writeFile(instructionsFilePath, "FULL INSTRUCTION BODY", "utf8");
  const script = adapter === "codex"
    ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
if (args.includes("resume")) { console.error("unknown thread"); process.exit(1); }
console.log(JSON.stringify({type:"thread.started",thread_id:"codex-fresh"}));
console.log(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"done"}}));
console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:1,cached_input_tokens:0,output_tokens:1}}));
`
    : adapter === "claude"
      ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) {
  console.log(JSON.stringify({type:"result",subtype:"error",is_error:true,result:"unknown session",session_id:"stale-session"}));
  process.exit(1);
}
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"claude-fresh",model:"test"}));
console.log(JSON.stringify({type:"result",subtype:"success",session_id:"claude-fresh",result:"done",usage:{input_tokens:1,output_tokens:1}}));
`
      : adapter === "commandcode"
        ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) { console.error("unknown session id"); process.exit(1); }
console.log(JSON.stringify({type:"result",subtype:"success",sessionId:"commandcode-fresh",usage:{inputTokens:1,outputTokens:1},durationMs:1,finalText:"done"}));
`
      : adapter === "pi"
        ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args.includes("--list-models")) {
  console.log("provider  model");
  console.log("openai    gpt-4.1-mini");
  process.exit(0);
}
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
const sessionIndex = args.indexOf("--session");
const session = sessionIndex >= 0 ? args[sessionIndex + 1] : "";
if (session === "stale-session") { console.error("unknown session id"); process.exit(1); }
process.stdin.once("data", () => {
  console.log(JSON.stringify({type:"session",version:3,id:"pi-fresh",cwd:process.cwd()}));
  console.log(JSON.stringify({type:"turn_end",message:{role:"assistant",content:[{type:"text",text:"done"}],usage:{input:1,output:1,cacheRead:0,cost:{total:0}}},toolResults:[]}));
  console.log(JSON.stringify({type:"agent_end",willRetry:false}));
  console.log(JSON.stringify({type:"agent_settled"}));
});
`
        : adapter === "opencode"
          ? `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "models") { console.log("openai/gpt-4.1-mini"); process.exit(0); }
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
if (args.includes("--session")) { console.error("unknown session id"); process.exit(1); }
console.log(JSON.stringify({type:"text",sessionID:"opencode-fresh",part:{text:"done"}}));
console.log(JSON.stringify({type:"step_finish",sessionID:"opencode-fresh",part:{reason:"done",cost:0,tokens:{input:1,output:1,reasoning:0,cache:{read:0,write:0}}}}));
`
          : `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.ATTEMPTS_PATH, JSON.stringify(args) + "\\n");
if (args.includes("--resume")) { console.error("unknown session"); process.exit(1); }
console.log(JSON.stringify({type:"system",subtype:"init",session_id:"${adapter}-fresh",model:"test"}));
console.log(JSON.stringify({type:"assistant",message:{content:[{type:"output_text",text:"done"}]}}));
console.log(JSON.stringify({type:"result",subtype:"success",session_id:"${adapter}-fresh",result:"done"}));
`;
  await fs.writeFile(command, script, "utf8");
  await fs.chmod(command, 0o755);
  const loaded = await loadInstructionsWithInlinedReferences(instructionsFilePath);
  return { cwd, command, attemptsPath, instructionsFilePath, contentHash: hashLoadedInstructions(loaded) };
}

async function run(adapter: Adapter, mode: "full" | "compact") {
  const f = await fixture(adapter);
  const execute = adapter === "codex"
    ? executeCodex
    : adapter === "claude"
      ? executeClaude
        : adapter === "commandcode"
          ? executeCommandCode
      : adapter === "cursor"
        ? executeCursor
        : adapter === "gemini"
          ? executeGemini
          : adapter === "opencode"
            ? executeOpenCode
            : executePi;
  const result = await execute({
    runId: `${adapter}-${mode}`,
    agent: {
      id: "agent-1",
      companyId: "company-1",
      name: "Agent",
      adapterType: `${adapter}_local`,
      adapterConfig: {},
    },
    runtime: {
      sessionId: "stale-session",
      sessionParams: { sessionId: "stale-session", cwd: f.cwd },
      sessionDisplayId: "stale-session",
      taskKey: "issue:one",
    },
    config: {
      command: f.command,
      cwd: f.cwd,
      instructionsFilePath: f.instructionsFilePath,
      promptTemplate: "Continue.",
      env: { ATTEMPTS_PATH: f.attemptsPath },
      maxOverloadRetries: 0,
      provider: "openai",
      model: adapter === "pi" || adapter === "opencode" ? "openai/gpt-4.1-mini" : undefined,
    },
    context: {
      paperclipInstructionInjection: {
        mode,
        contentHash: f.contentHash,
        deliveryToken: `${adapter}-${mode}-delivery`,
      },
    },
    onLog: async () => {},
  });
  const attempts = (await fs.readFile(f.attemptsPath, "utf8")).trim().split("\n").filter(Boolean);
  return { result, attempts };
}

describe.each(["codex", "claude", "commandcode", "cursor", "gemini", "opencode", "pi"] as const)("%s instruction injection stale-session fallback", (adapter) => {
  it("preserves the existing same-call fresh fallback for full instructions", async () => {
    const { result, attempts } = await run(adapter, "full");
    expect(attempts).toHaveLength(2);
    expect(result.exitCode).toBe(0);
    expect(result.clearSession).toBe(false);
    if (adapter === "pi") expect(result.sessionId).not.toBe("stale-session");
    else expect(result.sessionId).toBe(`${adapter}-fresh`);
  });

  it("does not start a fresh child with compact instructions", async () => {
    const { result, attempts } = await run(adapter, "compact");
    expect(attempts).toHaveLength(1);
    expect(result.exitCode).not.toBe(0);
    expect(result.clearSession).toBe(true);
    expect(result.sessionId).toBeNull();
  });
});
