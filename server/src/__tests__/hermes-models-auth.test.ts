import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { listHermesModels, resetHermesModelsCacheForTests } from "../adapters/hermes-models.js";

const ORIGINAL_HERMES_HOME = process.env.HERMES_HOME;

function makeTempHermesHome(prefix: string): string {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env.HERMES_HOME = home;
  return home;
}

function writeProviderModelsCache(home: string, payload: Record<string, unknown>) {
  fs.writeFileSync(
    path.join(home, "provider_models_cache.json"),
    JSON.stringify(payload),
    "utf8",
  );
}

function writeFakeVenvPython(home: string, probeJson: unknown) {
  const binDir = path.join(home, "hermes-agent", "venv", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const script = path.join(binDir, "python");
  fs.writeFileSync(
    script,
    `#!/usr/bin/env bash
echo "dotenv banner noise"
echo "@@PAPERCLIP_HERMES_AUTH@@"
echo '${JSON.stringify(probeJson).replace(/'/g, "'\\''")}'
`,
    { mode: 0o755 },
  );
  return script;
}

describe("hermes model listing (runtime probe is source of truth)", () => {
  beforeEach(() => {
    resetHermesModelsCacheForTests();
  });

  afterEach(() => {
    if (ORIGINAL_HERMES_HOME === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = ORIGINAL_HERMES_HOME;
    resetHermesModelsCacheForTests();
  });

  it("uses probe models and ignores stale cache-file rows", async () => {
    const home = makeTempHermesHome("paperclip-hermes-probe-");
    // stale file rows (retired + unauthenticated) must NOT leak into the list
    writeProviderModelsCache(home, {
      "openai-codex": { models: ["gpt-5.6-terra-pro"] },
      zai: { models: ["glm-4.5", "glm-4.6"] },
    });
    writeFakeVenvPython(home, {
      providers: ["zai", "opencode-go"],
      aliases: { zai: ["glm"] },
      models: { zai: ["glm-5.3", "glm-5.2"], "opencode-go": ["deepseek-v4-flash"] },
    });

    const models = await listHermesModels();

    expect(models.map((m) => m.id)).toEqual([
      "opencode-go/deepseek-v4-flash",
      "zai/glm-5.2",
      "zai/glm-5.3",
    ]);
  });

  it("merges codex fallback models only when openai-codex is authenticated", async () => {
    const home = makeTempHermesHome("paperclip-hermes-codex-");
    writeFakeVenvPython(home, {
      providers: ["openai-codex"],
      aliases: {},
      models: { "openai-codex": ["gpt-5.6-sol"] },
    });
    const withCodex = await listHermesModels();
    expect(withCodex.some((m) => m.id === "openai-codex/gpt-5.6-sol")).toBe(true);
    expect(withCodex.length).toBeGreaterThan(1); // fallback catalog merged

    const home2 = makeTempHermesHome("paperclip-hermes-nocodex-");
    writeFakeVenvPython(home2, {
      providers: ["zai"],
      aliases: {},
      models: { zai: ["glm-5.2"] },
    });
    const withoutCodex = await listHermesModels();
    expect(withoutCodex.some((m) => m.id.startsWith("openai-codex/"))).toBe(false);
  });

  it("returns an empty list when the probe authenticates nothing", async () => {
    const home = makeTempHermesHome("paperclip-hermes-empty-");
    writeFakeVenvPython(home, { providers: [], aliases: {}, models: {} });
    const models = await listHermesModels();
    expect(models).toEqual([]);
  });

  it("falls back to cache file + auth.json pool when venv python is unavailable", async () => {
    const home = makeTempHermesHome("paperclip-hermes-pool-");
    writeProviderModelsCache(home, {
      "openai-codex": { models: ["gpt-5.6-sol"] },
      "opencode-go": { models: ["deepseek-v4-flash"] },
    });
    fs.writeFileSync(
      path.join(home, "auth.json"),
      JSON.stringify({
        credential_pool: {
          "openai-codex": [],
          "opencode-go": [{ id: "cred-1" }],
        },
      }),
      "utf8",
    );

    const models = await listHermesModels();
    expect(models.map((m) => m.id)).toEqual(["opencode-go/deepseek-v4-flash"]);
  });
});
