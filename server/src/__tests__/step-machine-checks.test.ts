// [machine-check gates] Pure evaluator tests — no DB, no dag-engine.
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  STEP_MACHINE_CHECKS_TOOL,
  evaluateStepMachineChecks,
  globToRegExp,
  isPathInsideOrEqual,
  renderMachineCheckFailure,
} from "../services/workflow/step-machine-checks.js";

async function makeWorkspace(): Promise<string> {
  return fs.promises.mkdtemp(path.join(os.tmpdir(), "mc-gates-"));
}

function mapResolver(paths: Record<string, string>) {
  return (tokened: string): string | null => {
    const match = /^\{\$steps\.([A-Za-z0-9_-]+)\.(workProductPath|workProductDir|siblingAssetsDir)\}$/.exec(tokened);
    if (!match) return tokened.includes("{$steps.") ? null : tokened;
    return paths[match[1]!] ?? null;
  };
}

describe("STEP_MACHINE_CHECKS_TOOL", () => {
  it("is the reserved unregistered tool name", () => {
    expect(STEP_MACHINE_CHECKS_TOOL).toBe("step-machine-checks");
  });
});

describe("evaluateStepMachineChecks predicates", () => {
  it("file_exists: ok for a file, fails for missing path and for a directory", async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, "report.html");
    await fs.promises.writeFile(filePath, "<html></html>");
    await fs.promises.mkdir(path.join(workspace, "dir"));

    const ok = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: filePath }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(ok.ok).toBe(true);

    const missing = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: path.join(workspace, "nope.html") }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(missing.ok).toBe(false);
    expect(missing.results[0]!.ok).toBe(false);

    const directory = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: path.join(workspace, "dir") }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(directory.ok).toBe(false);
    expect(directory.results[0]!.detail).toBe("not a regular file");
  });

  it("file_glob: counts recursive matches and enforces minCount", async () => {
    const workspace = await makeWorkspace();
    await fs.promises.mkdir(path.join(workspace, "assets", "nested"), { recursive: true });
    await fs.promises.writeFile(path.join(workspace, "assets", "a.png"), "a");
    await fs.promises.writeFile(path.join(workspace, "assets", "nested", "b.png"), "b");
    await fs.promises.writeFile(path.join(workspace, "assets", "note.txt"), "t");

    const twoPngs = await evaluateStepMachineChecks({
      checks: [{ kind: "file_glob", dir: path.join(workspace, "assets"), glob: "**/*.png", minCount: 2 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(twoPngs.ok).toBe(true);

    const tooFew = await evaluateStepMachineChecks({
      checks: [{ kind: "file_glob", dir: path.join(workspace, "assets"), glob: "**/*.png", minCount: 3 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(tooFew.ok).toBe(false);
    expect(tooFew.results[0]!.detail).toContain("matched 2 file(s), required >= 3");

    const singleStarSegments = await evaluateStepMachineChecks({
      checks: [{ kind: "file_glob", dir: path.join(workspace, "assets"), glob: "*.png", minCount: 2 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(singleStarSegments.ok).toBe(false);

    const noMatch = await evaluateStepMachineChecks({
      checks: [{ kind: "file_glob", dir: path.join(workspace, "assets"), glob: "*.jpg", minCount: 1 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(noMatch.ok).toBe(false);
  });

  it("min_size_bytes: ok when size >= minBytes, fails when smaller or not a file", async () => {
    const workspace = await makeWorkspace();
    const filePath = path.join(workspace, "big.bin");
    await fs.promises.writeFile(filePath, Buffer.alloc(100, 1));

    const ok = await evaluateStepMachineChecks({
      checks: [{ kind: "min_size_bytes", path: filePath, minBytes: 100 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(ok.ok).toBe(true);

    const fail = await evaluateStepMachineChecks({
      checks: [{ kind: "min_size_bytes", path: filePath, minBytes: 101 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(fail.ok).toBe(false);
    expect(fail.results[0]!.detail).toContain("size 100 < 101");
  });

  it("content_sha256: ok on matching digest, fails on mismatch", async () => {
    const workspace = await makeWorkspace();
    const contents = "deterministic contents";
    const filePath = path.join(workspace, "hashed.txt");
    await fs.promises.writeFile(filePath, contents);
    const sha256 = createHash("sha256").update(contents).digest("hex");

    const ok = await evaluateStepMachineChecks({
      checks: [{ kind: "content_sha256", path: filePath, sha256 }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(ok.ok).toBe(true);

    const fail = await evaluateStepMachineChecks({
      checks: [{ kind: "content_sha256", path: filePath, sha256: "0".repeat(64) }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(fail.ok).toBe(false);
    expect(fail.results[0]!.detail).toContain("sha256 mismatch");
  });
});

describe("evaluateStepMachineChecks path handling", () => {
  it("resolves {$steps.<id>…} tokens through resolvePath and keeps them inside the workspace", async () => {
    const workspace = await makeWorkspace();
    const produced = path.join(workspace, "produced_work", "out.html");
    await fs.promises.mkdir(path.dirname(produced), { recursive: true });
    await fs.promises.writeFile(produced, "x");
    const tokened = "{$steps.producer-1.workProductPath}";

    const ok = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: tokened }],
      resolvePath: mapResolver({ "producer-1": produced }),
      workspaceCwd: workspace,
    });
    expect(ok.ok).toBe(true);
  });

  it("fails a check whose token cannot be resolved", async () => {
    const workspace = await makeWorkspace();
    const evaluation = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: "{$steps.producer-1.workProductPath}" }],
      resolvePath: mapResolver({}),
      workspaceCwd: workspace,
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.results[0]!.detail).toBe("unresolved path token");
  });

  it("rejects paths escaping the workspace", async () => {
    const workspace = await makeWorkspace();
    const outside = await makeWorkspace();
    const evaluation = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: outside }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.results[0]!.detail).toBe("path escapes workspace");

    const dotdot = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: path.join(workspace, "..", "elsewhere.html") }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(dotdot.ok).toBe(false);
    expect(dotdot.results[0]!.detail).toBe("path escapes workspace");
  });

  it("resolves relative literal paths against the workspace cwd", async () => {
    const workspace = await makeWorkspace();
    await fs.promises.writeFile(path.join(workspace, "rel.html"), "x");
    const evaluation = await evaluateStepMachineChecks({
      checks: [{ kind: "file_exists", path: "rel.html" }],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(evaluation.ok).toBe(true);
  });
});

describe("evaluateStepMachineChecks containment and fail-closed behavior", () => {
  it("never throws: a per-check error becomes ok:false and other checks still evaluate", async () => {
    const workspace = await makeWorkspace();
    const good = path.join(workspace, "good.html");
    await fs.promises.writeFile(good, "x");
    const evaluation = await evaluateStepMachineChecks({
      checks: [
        { kind: "file_exists", path: good },
        { kind: "min_size_bytes", path: good, minBytes: 10_000 },
        { kind: "file_glob", dir: path.join(workspace, "missing-dir"), glob: "*.html", minCount: 1 },
      ],
      resolvePath: (tokened) => tokened,
      workspaceCwd: workspace,
    });
    expect(evaluation.ok).toBe(false);
    expect(evaluation.results).toHaveLength(3);
    expect(evaluation.results[0]!.ok).toBe(true);
    expect(evaluation.results[1]!.ok).toBe(false);
    expect(evaluation.results[2]!.ok).toBe(false);
  });

  it("fails closed on an absent, empty, or malformed checks payload", async () => {
    for (const checks of [undefined, [], "junk", [{ kind: "file_exists", path: 42 }]]) {
      const evaluation = await evaluateStepMachineChecks({
        checks,
        resolvePath: (tokened) => tokened,
        workspaceCwd: os.tmpdir(),
      });
      expect(evaluation.ok).toBe(false);
      expect(evaluation.results).toHaveLength(1);
      expect(evaluation.results[0]!.detail).toContain("no valid machineChecks");
    }
  });

  it("renders failed checks into a single-line error", async () => {
    const message = renderMachineCheckFailure([
      { kind: "file_exists", path: "a.html", ok: true, detail: "file exists" },
      { kind: "min_size_bytes", path: "a.html", ok: false, detail: "size 1 < 5" },
    ]);
    expect(message).toBe("Machine checks failed (1/2): min_size_bytes a.html: size 1 < 5");
  });
});

describe("globToRegExp", () => {
  it("keeps * within one segment and lets ** cross separators", () => {
    const single = globToRegExp("*.html");
    expect(single.test("a.html")).toBe(true);
    expect(single.test("nested/a.html")).toBe(false);

    const double = globToRegExp("**/*.png");
    expect(double.test("a.png")).toBe(true);
    expect(double.test("nested/a.png")).toBe(true);
    expect(double.test("nested/deep/a.png")).toBe(true);
    expect(double.test("a.jpg")).toBe(false);

    const literal = globToRegExp("report[1].html");
    expect(literal.test("report[1].html")).toBe(true);
    expect(literal.test("report1.html")).toBe(false);
  });
});

describe("isPathInsideOrEqual", () => {
  it("accepts equal and nested paths, rejects siblings and parents", () => {
    expect(isPathInsideOrEqual("/ws/a", "/ws")).toBe(true);
    expect(isPathInsideOrEqual("/ws", "/ws")).toBe(true);
    expect(isPathInsideOrEqual("/ws2/a", "/ws")).toBe(false);
    expect(isPathInsideOrEqual("/ws/../etc", "/ws")).toBe(false);
  });
});
