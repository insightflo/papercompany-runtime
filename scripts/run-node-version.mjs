#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const nodeName = process.platform === "win32" ? "node.exe" : "node";

function readVersionFile(name) {
  const filePath = path.join(repoRoot, name);
  if (!existsSync(filePath)) return null;
  const value = readFileSync(filePath, "utf8").trim();
  return value.length > 0 ? value.replace(/^v/, "") : null;
}

function nodeVersionOf(nodePath) {
  const result = spawnSync(nodePath, ["-p", "process.versions.node"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status !== 0) return null;
  return result.stdout.trim().replace(/^v/, "") || null;
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function candidateNodePaths(version) {
  const nvmDir = process.env.NVM_DIR || path.join(os.homedir(), ".nvm");
  const envNode = process.env.PAPERCLIP_NODE_BIN || process.env.PAPERCLIP_NODE24_BIN;
  const pathCandidates = (process.env.PATH || "")
    .split(path.delimiter)
    .map((dir) => path.join(dir, nodeName));

  return unique([
    envNode,
    path.join(nvmDir, "versions", "node", `v${version}`, "bin", nodeName),
    path.join(os.homedir(), ".nvm", "versions", "node", `v${version}`, "bin", nodeName),
    ...pathCandidates,
  ]);
}

const requestedVersion =
  process.env.PAPERCLIP_NODE_VERSION ||
  readVersionFile(".node-version") ||
  readVersionFile(".nvmrc") ||
  "24.13.0";

const targetArgs = process.argv.slice(2);
if (targetArgs.length === 0) {
  process.stderr.write("[paperclip] Usage: run-node-version.mjs <script-or-node-arg> [...args]\n");
  process.exit(2);
}

const nodePath = candidateNodePaths(requestedVersion).find((candidate) => {
  if (!candidate || !existsSync(candidate)) return false;
  return nodeVersionOf(candidate) === requestedVersion;
});

if (!nodePath) {
  process.stderr.write(
    [
      `[paperclip] Node ${requestedVersion} is required but was not found.`,
      "Install it with `nvm install` from the repo root, or set PAPERCLIP_NODE_BIN to the desired node binary.",
      `Current node: ${process.version} (${process.execPath})`,
    ].join("\n") + "\n",
  );
  process.exit(1);
}

if (process.versions.node !== requestedVersion || path.resolve(process.execPath) !== path.resolve(nodePath)) {
  process.stderr.write(`[paperclip] using Node ${requestedVersion}: ${nodePath}\n`);
}

const result = spawnSync(nodePath, targetArgs, {
  cwd: process.cwd(),
  env: {
    ...process.env,
    PAPERCLIP_NODE_VERSION: requestedVersion,
    PATH: [path.dirname(nodePath), process.env.PATH].filter(Boolean).join(path.delimiter),
  },
  stdio: "inherit",
});

if (result.error) {
  process.stderr.write(`[paperclip] Failed to start Node ${requestedVersion}: ${result.error.message}\n`);
  process.exit(1);
}

if (result.signal) {
  process.kill(process.pid, result.signal);
}

process.exit(result.status ?? 1);
