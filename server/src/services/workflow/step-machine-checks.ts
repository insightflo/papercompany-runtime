// server/src/services/workflow/step-machine-checks.ts
//
// [ purpose ] Machine-checkable step postconditions — 결정론적 구조 게이트 전용
//   검증기. `step-machine-checks` 예약 toolName 을 가진 structural gate 스텝이
//   registry 없이 in-process 로 실행하는 코드 수준 술어 모음이다.
// [ authority — 규칙 8 ] 실행 권위는 materializer 가 스텝 toolArgs 에 기록한
//   구조화 machineChecks 배열(머신이 생성한 schema 검증 값)에만 있다. 자연어
//   사후조건 텍스트는 결코 파싱하지 않는다. 평가기는 절대 throw 하지 않고
//   검증별 오류를 ok:false detail 로 수집한다(fail-closed).

import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { WorkflowStepMachineCheck } from "@paperclipai/shared";
import { normalizeWorkflowStepMachineChecks } from "./step-contract.js";

/** Reserved structural-gate toolName. Never registered in the tool registry —
 * dag-engine special-cases it before registry resolution. */
export const STEP_MACHINE_CHECKS_TOOL = "step-machine-checks";

export interface StepMachineCheckResult {
  kind: string;
  path: string;
  ok: boolean;
  detail: string;
}

export interface StepMachineChecksEvaluation {
  ok: boolean;
  results: StepMachineCheckResult[];
}

const MAX_DETAIL_LENGTH = 500;

function clampDetail(detail: string): string {
  return detail.length > MAX_DETAIL_LENGTH ? `${detail.slice(0, MAX_DETAIL_LENGTH)}…` : detail;
}

/** Same containment rule as work-products/output-paths isPathInsideOrEqual.
 * Kept local so this module stays dependency-free and pure-testable. */
export function isPathInsideOrEqual(candidatePath: string, rootPath: string): boolean {
  const candidate = path.resolve(candidatePath);
  const root = path.resolve(rootPath);
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function resolveCheckPath(
  rawPath: string,
  resolvePath: (tokened: string) => string | null,
  workspaceCwd: string,
): { resolved: string } | { error: string } {
  const tokened = resolvePath(rawPath);
  if (!tokened || tokened.trim().length === 0) {
    return { error: "unresolved path token" };
  }
  const absolute = path.resolve(workspaceCwd, tokened.trim());
  if (!isPathInsideOrEqual(absolute, workspaceCwd)) {
    return { error: "path escapes workspace" };
  }
  return { resolved: absolute };
}

// Minimal glob matcher: a double-star token crosses directory separators (and a
// double-star followed by a slash also matches zero directories), a single star
// stays within one path segment; everything else is matched literally.
export function globToRegExp(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const char = glob[i]!;
    if (char === "*") {
      if (glob[i + 1] === "*") {
        if (glob[i + 2] === "/") {
          source += "(?:.*/)?";
          i += 2;
        } else {
          source += ".*";
          i += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if ("\\^$.|?+()[]{}".includes(char)) {
      source += "\\" + char;
    } else {
      source += char;
    }
  }
  return new RegExp(`^${source}$`, "u");
}

async function listFilesRelative(rootDir: string): Promise<string[]> {
  const files: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    const entries = await fs.promises.readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        files.push(path.relative(rootDir, full).split(path.sep).join("/"));
      }
    }
  };
  await walk(rootDir);
  return files;
}

async function evaluateSingleCheck(
  check: WorkflowStepMachineCheck,
  resolvePath: (tokened: string) => string | null,
  workspaceCwd: string,
): Promise<StepMachineCheckResult> {
  try {
    if (check.kind === "file_glob") {
      const displayPath = check.dir;
      const resolved = resolveCheckPath(check.dir, resolvePath, workspaceCwd);
      if ("error" in resolved) return { kind: check.kind, path: displayPath, ok: false, detail: resolved.error };
      const stat = await fs.promises.stat(resolved.resolved);
      if (!stat.isDirectory()) {
        return { kind: check.kind, path: displayPath, ok: false, detail: "not a directory" };
      }
      const matcher = globToRegExp(check.glob);
      const matches = (await listFilesRelative(resolved.resolved)).filter((file) => matcher.test(file));
      const ok = matches.length >= check.minCount;
      return {
        kind: check.kind,
        path: displayPath,
        ok,
        detail: ok
          ? `matched ${matches.length} file(s) >= ${check.minCount}`
          : `matched ${matches.length} file(s), required >= ${check.minCount}`,
      };
    }

    const displayPath = check.path;
    const resolved = resolveCheckPath(check.path, resolvePath, workspaceCwd);
    if ("error" in resolved) return { kind: check.kind, path: displayPath, ok: false, detail: resolved.error };
    if (check.kind === "file_exists") {
      const stat = await fs.promises.stat(resolved.resolved);
      const ok = stat.isFile();
      return { kind: check.kind, path: displayPath, ok, detail: ok ? "file exists" : "not a regular file" };
    }
    if (check.kind === "min_size_bytes") {
      const stat = await fs.promises.stat(resolved.resolved);
      const ok = stat.isFile() && stat.size >= check.minBytes;
      return {
        kind: check.kind,
        path: displayPath,
        ok,
        detail: ok ? `size ${stat.size} >= ${check.minBytes}` : `size ${stat.size} < ${check.minBytes}`,
      };
    }
    // content_sha256
    const contents = await fs.promises.readFile(resolved.resolved);
    const digest = createHash("sha256").update(contents).digest("hex");
    const ok = digest === check.sha256.toLowerCase();
    return {
      kind: check.kind,
      path: displayPath,
      ok,
      detail: ok ? "sha256 matches" : `sha256 mismatch (expected ${check.sha256.toLowerCase()}, got ${digest})`,
    };
  } catch (error) {
    return {
      kind: check.kind,
      path: check.kind === "file_glob" ? check.dir : check.path,
      ok: false,
      detail: clampDetail(error instanceof Error ? error.message : String(error)),
    };
  }
}

/**
 * Evaluates a machineChecks payload. Never throws — per-check errors (missing
 * files, permission, IO) become ok:false results. An absent/empty/unparseable
 * payload fails closed with one synthetic result: a materialized gate must
 * always carry at least one check.
 */
export async function evaluateStepMachineChecks(input: {
  checks: unknown;
  resolvePath: (tokened: string) => string | null;
  workspaceCwd: string;
}): Promise<StepMachineChecksEvaluation> {
  const checks = normalizeWorkflowStepMachineChecks(input.checks);
  if (!checks || checks.length === 0) {
    return {
      ok: false,
      results: [{ kind: "machineChecks", path: "", ok: false, detail: "no valid machineChecks on gate step" }],
    };
  }
  const results: StepMachineCheckResult[] = [];
  for (const check of checks) {
    results.push(await evaluateSingleCheck(check, input.resolvePath, input.workspaceCwd));
  }
  return { ok: results.every((result) => result.ok), results };
}

/** Renders failed checks into a compact single-line error for step-run metadata. */
export function renderMachineCheckFailure(results: StepMachineCheckResult[]): string {
  const failed = results.filter((result) => !result.ok);
  const lines = failed.map((result) => `${result.kind} ${result.path || "(none)"}: ${result.detail}`);
  return `Machine checks failed (${failed.length}/${results.length}): ${lines.join("; ")}`;
}
