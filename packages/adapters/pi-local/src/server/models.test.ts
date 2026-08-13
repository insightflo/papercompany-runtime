import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  discoverPiModels,
  ensurePiModelConfiguredAndAvailable,
  listPiModels,
  resetPiModelsCacheForTests,
} from "./models.js";

describe("pi models", () => {
  afterEach(() => {
    delete process.env.PAPERCLIP_PI_COMMAND;
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
