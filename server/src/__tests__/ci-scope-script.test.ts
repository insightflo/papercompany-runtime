/**
 * [CI-REDUCE 2026-11-13] scripts/ci-scope.sh 트리거 행렬 시험.
 *
 * 왜: pr.yml 은 이 스크립트의 출력만 소비한다. 판정이 틀리면 (a) 전체 스위트가 영영 돌지 않아
 *   병합 파이프라인이 CI 판정 근거를 못 찾거나(과소 실행), (b) 줄이려던 전량 실행이 그대로 돌아
 *   비용 절감이 사라진다(과대 실행). 그래서 워크플로 YAML 이 아니라 **실제 스크립트**를 실행해
 *   이벤트 조합마다 기대 출력을 고정한다.
 *
 * 검증 범위: 이벤트·드래프트·라벨·dispatch scope·변경 파일 조합 → fast/heavy/full/docs_only/reason.
 * 검증하지 않는 것: GitHub 이 `labeled`/`ready_for_review` 를 어떤 payload 로 보내는지, 워크플로 `if:`
 *   문법의 유효성(actionlint 담당), pr.yml 이 이 출력으로 실제 잡을 띄우는지(CI 실행 증거로만 확인 가능).
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "../../../scripts/ci-scope.sh");
const sandbox = mkdtempSync(join(tmpdir(), "ci-scope-"));

afterAll(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

let fileSeq = 0;
/** 변경 파일 목록 픽스처를 만들고 경로를 돌려준다. null 이면 목록 자체를 주지 않는다(모르는 상태). */
function changedList(files: string[] | null): string | undefined {
  if (files === null) return undefined;
  fileSeq += 1;
  const path = join(sandbox, `changed-${fileSeq}.txt`);
  writeFileSync(path, files.map((f) => `${f}\n`).join(""));
  return path;
}

type Scope = {
  fast: string;
  heavy: string;
  full: string;
  docs_only: string;
  reason: string;
};

function runScope(input: {
  eventName?: string;
  action?: string;
  draft?: string;
  labels?: string;
  inputScope?: string;
  changed?: string[] | null;
}): Scope {
  const listPath = changedList(input.changed === undefined ? ["server/src/index.ts"] : input.changed);
  const env: Record<string, string> = {
    PATH: process.env.PATH ?? "",
    EVENT_NAME: input.eventName ?? "pull_request",
    EVENT_ACTION: input.action ?? "synchronize",
    PR_DRAFT: input.draft ?? "false",
    PR_LABELS: input.labels ?? "",
    INPUT_SCOPE: input.inputScope ?? "",
    CI_FULL_LABEL: "ci-full",
  };
  if (listPath !== undefined) env.CHANGED_FILE_LIST = listPath;

  const stdout = execFileSync("/bin/bash", [SCRIPT], { env, encoding: "utf8" });
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const idx = line.indexOf("=");
    if (idx > 0) out[line.slice(0, idx)] = line.slice(idx + 1);
  }
  return out as Scope;
}

describe("ci-scope.sh trigger matrix", () => {
  it("runs only the light job on a plain push", () => {
    expect(runScope({ action: "synchronize", changed: ["server/src/routes/approvals.ts"] })).toEqual({
      fast: "true",
      heavy: "true",
      full: "false",
      docs_only: "false",
      reason: "push-fast-only",
    });
  });

  it("opens and reopens like a plain push (no full suite without an explicit signal)", () => {
    for (const action of ["opened", "reopened"]) {
      expect(runScope({ action }).full).toBe("false");
    }
  });

  it("skips the heavy steps for docs-only changes", () => {
    const scope = runScope({ action: "synchronize", changed: ["README.md", "docs/onboarding.md", "doc/SPEC.md"] });
    expect(scope).toEqual({
      fast: "true",
      heavy: "false",
      full: "false",
      docs_only: "true",
      reason: "push-fast-only+docs-only",
    });
  });

  it("counts doc artifacts under doc/ and docs/ as documentation", () => {
    for (const path of ["docs/docs.json", "docs/flowmap/flowmap.html", "docs/logo.svg", "doc/a/b.png"]) {
      expect(runScope({ changed: [path] }).docs_only).toBe("true");
    }
  });

  it("treats code files under doc/ and docs/ as code (never as docs-only)", () => {
    // 문서로 오인하면 전체 스위트가 돌지 않아 테스트 0회로 병합될 수 있다.
    for (const path of ["doc/scripts/run.sh", "docs/snippet.ts", "docs/schema.py", "doc/migrate.sql"]) {
      const scope = runScope({ changed: [path] });
      expect(scope.docs_only).toBe("false");
      expect(scope.heavy).toBe("true");
    }
  });

  it("treats a single code file among docs as a code change", () => {
    const scope = runScope({ changed: ["README.md", "server/src/index.ts"] });
    expect(scope.docs_only).toBe("false");
    expect(scope.heavy).toBe("true");
  });

  it("does not treat an unknown change list as docs-only", () => {
    const scope = runScope({ changed: [] });
    expect(scope.docs_only).toBe("false");
    expect(scope.heavy).toBe("true");
  });

  it("runs nothing for draft pull requests", () => {
    expect(runScope({ draft: "true", action: "synchronize" })).toEqual({
      fast: "false",
      heavy: "false",
      full: "false",
      docs_only: "false",
      reason: "draft",
    });
  });

  it("still runs the full suite on a draft when the full label was attached explicitly", () => {
    // 병합 파이프라인은 드래프트 PR 에 라벨을 붙여 전체 스위트를 깨운다. 드래프트를 우선하면
    // 그 PR 은 가드를 통과할 수 없어 영구 미병합이 된다(가드 통과 전에는 gh pr ready 에 도달하지 않는다).
    const scope = runScope({ draft: "true", labels: "ci-full" });
    expect(scope.fast).toBe("true");
    expect(scope.full).toBe("true");
  });

  it("runs the full suite when the ci-full label is attached", () => {
    const scope = runScope({ action: "labeled", labels: "ci-full" });
    expect(scope.full).toBe("true");
    expect(scope.heavy).toBe("true");
    expect(scope.reason).toBe("ci-full-label");
  });

  it("keeps the full suite running on later pushes while the label stays", () => {
    expect(runScope({ action: "synchronize", labels: "ci-full" }).full).toBe("true");
  });

  it("keeps the full suite running when another label is added later", () => {
    // 라벨 이벤트가 'ci-full 추가'가 아니어도, ci-full 이 붙은 PR 의 최신 run 이 전체 스위트가 되게 한다.
    // (그렇지 않으면 병합 파이프라인의 CI 판정이 verify-tests 가 전부 skipped 인 run 을 최신으로 보고 병합을 보류한다.)
    expect(runScope({ action: "labeled", labels: "bug, ci-full" }).full).toBe("true");
  });

  it("ignores labels that merely look like the full label", () => {
    const scope = runScope({ action: "labeled", labels: "ci-full-extra" });
    expect(scope.full).toBe("false");
    expect(scope.reason).toBe("push-fast-only");
  });

  it("runs the full suite when the pull request becomes ready for review", () => {
    const scope = runScope({ action: "ready_for_review", draft: "false" });
    expect(scope.full).toBe("true");
    expect(scope.reason).toBe("ready_for_review");
  });

  it("skips the full suite for docs-only changes even with the full label", () => {
    // 문서 전용 PR 에 전체 스위트를 돌리지 않는 대신, pr.yml 이 verify-tests-docs-only 잡을 성공으로 남겨
    // "전체 스위트 불필요"를 병합 가드에 구조화해 알린다(가드는 verify-tests 성공 잡이 0개면 병합하지 않는다).
    const scope = runScope({ action: "labeled", labels: "ci-full", changed: ["README.md", "docs/docs.json"] });
    expect(scope.full).toBe("false");
    expect(scope.heavy).toBe("false");
    expect(scope.reason).toBe("ci-full-label+docs-only");
  });

  it("keeps the lockfile-bot dispatch path on policy only", () => {
    // 기본값(policy): GITHUB_TOKEN 이 만든 lockfile PR 에 필수 검사만 붙이는 기존 경로.
    const scope = runScope({ eventName: "workflow_dispatch", action: "", draft: "" });
    expect(scope.fast).toBe("true");
    expect(scope.heavy).toBe("true");
    expect(scope.full).toBe("false");
    expect(scope.reason).toBe("dispatch-policy");
  });

  it("runs the full suite for a manual dispatch with scope=full, even over a docs-only diff", () => {
    for (const changed of [["README.md"], null]) {
      const scope = runScope({ eventName: "workflow_dispatch", action: "", draft: "", inputScope: "full", changed });
      expect(scope.full).toBe("true");
      expect(scope.heavy).toBe("true");
      expect(scope.reason).toBe("dispatch-full");
    }
  });

  it("mirrors every key into GITHUB_OUTPUT", () => {
    const outPath = join(sandbox, "github-output");
    writeFileSync(outPath, "");
    const env: Record<string, string> = {
      PATH: process.env.PATH ?? "",
      EVENT_NAME: "pull_request",
      EVENT_ACTION: "ready_for_review",
      PR_DRAFT: "false",
      PR_LABELS: "",
      CI_FULL_LABEL: "ci-full",
      CHANGED_FILE_LIST: changedList(["server/src/index.ts"]) as string,
      GITHUB_OUTPUT: outPath,
    };
    execFileSync("/bin/bash", [SCRIPT], { env, encoding: "utf8" });
    const written = readFileSync(outPath, "utf8");
    expect(written).toContain("full=true");
    expect(written).toContain("heavy=true");
    expect(written).toContain("reason=ready_for_review");
  });
});
