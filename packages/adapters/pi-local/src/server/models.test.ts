import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverPiModels,
  discoverPiModelsCached,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
    delete process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS;
    resetPiModelsCacheForTests();
  });

  it("returns an empty list when discovery command is unavailable", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(listPiModels()).resolves.toEqual([]);
  });

  it("reads model discovery output emitted on stderr by current Pi", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-"));
    const command = path.join(root, "pi");
    await fs.writeFile(
      command,
      '#!/usr/bin/env node\nprocess.stderr.write("provider  model\\n test  model\\n");\n',
      "utf8",
    );
    await fs.chmod(command, 0o755);
    try {
      await expect(discoverPiModels({ command, cwd: process.cwd() })).resolves.toEqual([
        { id: "test/model", label: "test/model" },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("combines model tables from stdout and stderr without duplicates", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-mixed-"));
    const command = path.join(root, "pi");
    await fs.writeFile(
      command,
      '#!/usr/bin/env node\n' +
        'process.stderr.write("warning:  using cached auth\\nprovider  model\\n test  model\\n");\n' +
        'process.stdout.write("provider  model\\n test  model\\n other  model\\n");\n',
      "utf8",
    );
    await fs.chmod(command, 0o755);
    try {
      await expect(discoverPiModels({ command, cwd: process.cwd() })).resolves.toEqual([
        { id: "other/model", label: "other/model" },
        { id: "test/model", label: "test/model" },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not turn an unheaded stderr warning into a model", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-warning-"));
    const command = path.join(root, "pi");
    await fs.writeFile(
      command,
      '#!/usr/bin/env node\n' +
        'process.stderr.write("warning:  cached auth is being used\\n");\n' +
        'process.stdout.write("provider  model\\n test  model\\n");\n',
      "utf8",
    );
    await fs.chmod(command, 0o755);
    try {
      await expect(discoverPiModels({ command, cwd: process.cwd() })).resolves.toEqual([
        { id: "test/model", label: "test/model" },
      ]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when model is missing", async () => {
    await expect(
      ensurePiModelConfiguredAndAvailable({ model: "" }),
    ).rejects.toThrow("Pi requires `adapterConfig.model`");
  });

  it("rejects when discovery cannot run for configured model", async () => {
    process.env.PAPERCLIP_PI_COMMAND = "__paperclip_missing_pi_command__";
    await expect(
      ensurePiModelConfiguredAndAvailable({
        model: "xai/grok-4",
      }),
    ).rejects.toThrow();
  });
});

describe("pi models cache TTL", () => {
  let root: string;
  let command: string;
  let attemptsPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-pi-models-ttl-"));
    command = path.join(root, "pi");
    attemptsPath = path.join(root, "attempts");
    const script = [
      "#!/usr/bin/env node",
      "const fs = require('node:fs');",
      `const attemptsPath = ${JSON.stringify(attemptsPath)};`,
      "let attempt = 1;",
      "try { attempt = Number(fs.readFileSync(attemptsPath, 'utf8')) + 1; } catch {}",
      "fs.writeFileSync(attemptsPath, String(attempt));",
      "process.stdout.write('provider  model\\ntest  model\\n');",
      "process.exit(0);",
    ].join("\n");
    await fs.writeFile(command, script, "utf8");
    await fs.chmod(command, 0o755);
  });

  afterEach(async () => {
    delete process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS;
    resetPiModelsCacheForTests();
    await fs.rm(root, { recursive: true, force: true });
  });

  async function readAttempts(): Promise<number> {
    try {
      return Number(await fs.readFile(attemptsPath, "utf8"));
    } catch {
      return 0;
    }
  }

  it("serves repeated discovery from the cache within the TTL", async () => {
    await expect(discoverPiModelsCached({ command, cwd: root })).resolves.toEqual([
      { id: "test/model", label: "test/model" },
    ]);
    await expect(discoverPiModelsCached({ command, cwd: root })).resolves.toEqual([
      { id: "test/model", label: "test/model" },
    ]);
    expect(await readAttempts()).toBe(1);
  });

  it("honors PAPERCLIP_PI_MODELS_CACHE_TTL_MS=0 by re-running discovery", async () => {
    process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = "0";
    await discoverPiModelsCached({ command, cwd: root });
    await discoverPiModelsCached({ command, cwd: root });
    expect(await readAttempts()).toBe(2);
  });

  it("falls back to the default TTL for invalid or negative overrides", async () => {
    for (const invalid of ["not-a-number", "-1", ""]) {
      resetPiModelsCacheForTests();
      await fs.rm(attemptsPath, { force: true });
      process.env.PAPERCLIP_PI_MODELS_CACHE_TTL_MS = invalid;
      await discoverPiModelsCached({ command, cwd: root });
      await discoverPiModelsCached({ command, cwd: root });
      expect(await readAttempts()).toBe(1);
    }
  });

  it("reports cache hits through the onCacheHit hook", async () => {
    const hits: boolean[] = []
    await discoverPiModelsCached({ command, cwd: root, onCacheHit: (hit) => hits.push(hit) });
    await discoverPiModelsCached({ command, cwd: root, onCacheHit: (hit) => hits.push(hit) });
    expect(hits).toEqual([false, true]);
  });
});
