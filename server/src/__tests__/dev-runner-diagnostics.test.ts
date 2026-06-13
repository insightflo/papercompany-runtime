import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  appendDevRunnerEvent,
  evaluateNodeRuntime,
  findRecentNodeCrashReports,
  resolveDevRunnerDiagnosticsPaths,
} from "../../../scripts/dev-runner-diagnostics.mjs";

describe("dev-runner diagnostics", () => {
  it("resolves diagnostics paths under repo-local .paperclip by default", () => {
    const repoRoot = path.join(os.tmpdir(), "paperclip-runtime");
    expect(resolveDevRunnerDiagnosticsPaths(repoRoot, {})).toEqual({
      logDir: path.join(repoRoot, ".paperclip"),
      eventLogPath: path.join(repoRoot, ".paperclip", "dev-runner-events.ndjson"),
      childLogPath: path.join(repoRoot, ".paperclip", "dev-runner-child.log"),
    });
  });

  it("appends structured event lines", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-dev-runner-diag-"));
    const eventLogPath = path.join(dir, "events.ndjson");

    appendDevRunnerEvent(eventLogPath, "server_child_exited", {
      code: 1,
      signal: null,
    });

    const [line] = fs.readFileSync(eventLogPath, "utf8").trim().split("\n");
    const parsed = JSON.parse(line);
    expect(parsed.event).toBe("server_child_exited");
    expect(parsed.code).toBe(1);
    expect(parsed.signal).toBeNull();
    expect(typeof parsed.ts).toBe("string");
  });

  it("finds recent node crash reports and ignores old reports", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-node-crashes-"));
    const recentPath = path.join(dir, "node-2026-06-12-185320.ips");
    const oldPath = path.join(dir, "node-2026-06-01-000000.ips");
    const otherPath = path.join(dir, "other-2026-06-12-185320.ips");
    fs.writeFileSync(recentPath, "recent", "utf8");
    fs.writeFileSync(oldPath, "old", "utf8");
    fs.writeFileSync(otherPath, "other", "utf8");

    const oldTime = new Date("2026-06-01T00:00:00.000Z");
    fs.utimesSync(oldPath, oldTime, oldTime);

    const reports = findRecentNodeCrashReports({
      dirs: [dir],
      sinceMs: Date.now() - 60_000,
    });

    expect(reports.map((report) => path.basename(report.path))).toEqual([
      "node-2026-06-12-185320.ips",
    ]);
  });

  it("accepts the pinned Node 24 runtime ABI", () => {
    expect(evaluateNodeRuntime({
      nodeVersion: "v24.13.0",
      nodeModuleVersion: "137",
      requiredMajor: 24,
    })).toEqual({
      ok: true,
      currentMajor: 24,
      expectedNodeModuleVersion: "137",
      message: null,
    });
  });

  it("rejects Node 25 before re2 can fail with an ABI mismatch", () => {
    const result = evaluateNodeRuntime({
      nodeVersion: "v25.8.10",
      nodeModuleVersion: "141",
      requiredMajor: 24,
    });

    expect(result.ok).toBe(false);
    expect(result.currentMajor).toBe(25);
    expect(result.expectedNodeModuleVersion).toBe("137");
    expect(result.message).toContain("Node 24");
    expect(result.message).toContain("re2");
    expect(result.message).toContain("NODE_MODULE_VERSION 137");
  });
});
