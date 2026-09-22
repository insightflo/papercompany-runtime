import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("../../../scripts/deploy-a1.sh", import.meta.url));
const tempDirs: string[] = [];
const fixtureSha = "1111111111111111111111111111111111111111";

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("retired legacy A1 deployment", () => {
  // Catches checkout/install/restart before refusal, or an environment/force bypass.
  it.each(["default", "former overrides"])("refuses %s without external commands or lock creation", (mode) => {
    const root = mkdtempSync(path.join(os.tmpdir(), "papercompany-deploy-retired-"));
    tempDirs.push(root);
    const checkout = path.join(root, "checkout");
    const bin = path.join(root, "bin");
    const calls = path.join(root, "calls.log");
    const lock = path.join(root, "deploy.lock");
    mkdirSync(checkout);
    mkdirSync(bin);
    execFileSync("git", ["init", "--quiet", checkout]);
    const sandboxScript = path.join(root, "deploy-a1.sh");
    copyFileSync(script, sandboxScript);
    writeFileSync(calls, "");

    // Only the external command boundary is replaced. Nothing can contact A1.
    // Let the old path reach restart; stop there before its shared /tmp health file.
    const recorder = `#!/bin/bash
printf '%s' "\${0##*/}" >> "$CALL_LOG"
printf ' %s' "$@" >> "$CALL_LOG"
printf '\\n' >> "$CALL_LOG"
case "\${0##*/}" in
  git)
    case "$1" in
      symbolic-ref) printf 'sandbox-old-branch\\n' ;;
      rev-parse) printf '${fixtureSha}\\n' ;;
    esac ;;
  sudo|systemctl|curl|ssh|scp) exit 97 ;;
esac
`;
    for (const name of ["git", "pnpm", "flock", "sudo", "systemctl", "curl", "ssh", "scp"]) {
      writeFileSync(path.join(bin, name), recorder, { mode: 0o755 });
    }
    const env: NodeJS.ProcessEnv = {
      PATH: bin,
      HOME: root,
      TMPDIR: root,
      CALL_LOG: calls,
      // These two sandbox overrides are mandatory even for the default scenario.
      A1_DEPLOY_PATH: checkout,
      A1_DEPLOY_LOCK_FILE: lock,
    };
    if (mode === "former overrides") Object.assign(env, {
      A1_DEPLOY_BRANCH: "main",
      A1_DEPLOY_REF: fixtureSha,
      A1_DEPLOY_EXPECTED_SHA: fixtureSha,
      A1_SERVICE_NAME: "sandbox-only.service",
      A1_INTERNAL_HEALTH_URL: "http://127.0.0.1:1/internal",
      A1_PUBLIC_HEALTH_URL: "http://127.0.0.1:1/public",
      A1_HEALTH_TIMEOUT_SECONDS: "1",
      A1_HEALTH_INTERVAL_SECONDS: "1",
      A1_LEGACY_DEPLOY_ENABLED: "true",
      A1_DEPLOY_FORCE: "true",
      FORCE: "1",
    });

    const result = spawnSync("/bin/bash", [sandboxScript, ...(mode === "former overrides" ? ["--force"] : [])], {
      cwd: checkout, env, encoding: "utf8", timeout: 5_000,
    });

    expect(result.error).toBeUndefined();
    expect(result.signal).toBeNull();
    expect.soft(readFileSync(calls, "utf8"), "no external command may run before refusal").toBe("");
    expect.soft(existsSync(lock), "refusal must not create the legacy deployment lock").toBe(false);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toMatch(/legacy.*retired/i);
    expect(result.stderr).toMatch(/safe runtime drain.*not implemented/i);
    expect(result.stderr).toContain("doc/DEPLOYMENT-SAFETY.md");
  });
});
