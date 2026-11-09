#!/usr/bin/env node
/**
 * check-run-status-write-chokepoint.mjs
 *
 * [write-chokepoint static guard] heartbeat_runs / workflow_runs 테이블에 대한
 * 직접 상태 쓰기(`.update(heartbeatRuns)` / `.update(workflowRuns)` 및 동등한
 * raw SQL UPDATE)를 인가된 쓰기 계층으로 강제하는 CI 정적 검사.
 *
 * 배경(reboot-1107/rust-engine-study.md §3–§4.3, PR #679/#682):
 *   미션 종료 정리·워크플로 종결 취소 경로가 초크포인트(setHeartbeatRunStatus →
 *   v1 finalization)를 우회해 raw UPDATE 를 날리는 것이 좀비 런 결함의 근본 원인이었다.
 *   이 가드는 동종 우회가 다시 들어오면 CI 를 실패시켜 재발을 차단한다(문제 감지 → CI 차단).
 *
 * 통과 조건:
 *   1. 테스트 코드(__tests__/, *.test.ts, *.spec.ts)는 제외 — 시드/검증이 직접 쓰기를 쓴다.
 *   2. 앱 런타임 소스(server/, packages/, cli/, ui/ … *.ts)에서 위 테이블 쓰기를 하려면
 *      아래 WRITE_ALLOWLIST 에 명시된 파일이어야 한다(아래 "정책" 참조).
 *   3. `--self-test` 는 가드 자체의 탐지 능력을 합성 bypass 사례로 검증한다(항상 CI 에서 실행).
 *
 * 정책(허용 목록 구조):
 *   - CHOKEPOINT: §4.3 이 지정한 공식 쓰기 계층(heartbeat-queue-lifecycle.ts 의
 *     setHeartbeatRunStatus 와 heartbeat-finalization/* 종결화 기록 계층).
 *   - LEGACY: 현재 main 에 존재하는 합법 사이트. 신규 추가는 금지되며(이 가드가 차단),
 *     setHeartbeatRunStatus / workflow 초크포인트 수립으로 단계적 수렴 대상이다.
 *
 * 사용:
 *   node scripts/check-run-status-write-chokepoint.mjs             # 검사 실행
 *   node scripts/check-run-status-write-chokepoint.mjs --self-test # 가드 자기 시험
 *   pnpm check:write-chokepoint                                    # package.json 스크립트
 *
 * 알려진 한계(설계상):
 *   - 동적 간접 참조(const t = heartbeatRuns; db.update(t))는 탐지하지 못한다.
 *     코드 리뷰 + 향후 §4.3-A 타입 기반 초크포인트(WriteModel)로 보완한다.
 *   - migrations/*.sql 은 스캔 대상이 아니다(.ts 만 검사). 데이터 백필은 마이그레이션
 *     리뷰 경로로 관리한다.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CANONICAL_TABLES = ["heartbeatRuns", "workflowRuns"];

// 스캔에서 제외하는 디렉터리(앱 런타임 소스 밖). scripts/ 는 이 가드 자신이
// 패턴 문자열을 포함하므로 제외한다.
const SKIP_DIRS = new Set([
  ".git",
  ".github",
  ".pi",
  ".next",
  ".turbo",
  "build",
  "coverage",
  "dist",
  "docs",
  "evals",
  "examples",
  "node_modules",
  "out",
  "patches",
  "playwright-report",
  "scripts",
  "test-results",
  "tests",
]);

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".mts", ".cts"]);

function isTestPath(path) {
  return path.includes("__tests__/") || /\.(test|spec)\.[cm]?tsx?$/.test(path);
}

// ---------------------------------------------------------------------------
// 허용 목록 — 서술한 파일 외의 모든 직접 쓰기는 CI 실패.
// 형식: [repo 상대 경로, 분류|한 줄 사유]
// ---------------------------------------------------------------------------
const WRITE_ALLOWLIST = new Map([
  // --- CHOKEPOINT: §4.3 지정 공식 쓰기 계층 -------------------------------
  [
    "server/src/services/heartbeat-queue-lifecycle.ts",
    "CHOKEPOINT|§4.3 지정. setHeartbeatRunStatus = heartbeat_runs 상태 전이 중앙 작성자(run-status fencing v1, CAS 지원)",
  ],
  [
    "server/src/services/heartbeat-finalization/shadow-writes.ts",
    "CHOKEPOINT|§4.3 지정(heartbeat-finalization/*). 종말 상태 섀도 기록 계층",
  ],
  [
    "server/src/services/heartbeat-finalization/authority-transfer.ts",
    "CHOKEPOINT|§4.3 지정. 실행 권한 이양(transfer) 상태 기록",
  ],
  [
    "server/src/services/heartbeat-finalization/settlement.ts",
    "CHOKEPOINT|§4.3 지정. 런 정산(settled_at) 기록",
  ],
  [
    "server/src/services/heartbeat-finalization/owner-capability.ts",
    "CHOKEPOINT|§4.3 지정. executor owner capability release/claim 칼럼 기록",
  ],
  // --- DATA: 상태 전이가 아닌 데이터 보존 정리 쓰기(신규 카테고리 2026-11-09) ----
  [
    "server/src/services/heartbeat-run-output-retention-write.ts",
    "DATA|보존 절단 정리 작업(2026-11-09 승인). result_json stdout/stderr 절단 전용 — 상태 전이 아님, status·updated_at 미갱신, 종결+보존일 초과 행만 대상. DB 내 절단 UPDATE(2026-11-09 OOM 수리 — 큰 본문을 Node 로 가져오지 않음), capHeartbeatRunResultJsonForStorage 계약의 SQL 재현.",
  ],
  // --- LEGACY: 현재 main 의 합법 사이트(신규 추가 금지, 단계적 수렴 대상) ----
  [
    "server/src/services/heartbeat.ts",
    "LEGACY|핵심 실행 엔진의 레거시 상태/패치 전이 16곳. setHeartbeatRunStatus 로 단계 수렴 대상",
  ],
  [
    "server/src/services/heartbeat-run-log.ts",
    "LEGACY|런 로그 저장소 참조(logStore/logRef)·활동 시각(updatedAt) 갱신 2곳(상태 전이 아님)",
  ],
  [
    "server/src/services/missions/terminal-cleanup-resources.ts",
    "LEGACY|#679 로 v1 finalization 준수 구조가 된 미션 종료 정리(fix/agent-idle-definition-20261109 브랜치와 중복 관할 — 이 가드는 등록만)",
  ],
  [
    "server/src/services/workflow/control-flow/qa-correction-delivery-receipt.ts",
    "LEGACY|QA 수정 전달 영수증 CAS 기록(#678 R3 계열)",
  ],
  [
    "server/src/services/workflow/run-terminal-effect-executor.ts",
    "LEGACY|#682 로 종결 계약을 준수하게 된 종결 효과 실행기의 런타임 종결 기록",
  ],
  // workflow_runs 는 아직 중앙 상태 작성자(초크포인트)가 없다 — 현재 합법 사이트 전부 등록.
  [
    "server/src/services/workflow/workflow-store.ts",
    "LEGACY|워크플로 스토어 기본 CRUD/상태 갱신 계층 3곳",
  ],
  [
    "server/src/services/workflow/workflow-run-finalization.ts",
    "LEGACY|런 종결(finalization) 상태 전이",
  ],
  [
    "server/src/services/workflow/failure-cascade-finalization.ts",
    "LEGACY|실패 계단(cascade) 종결 전이 2곳",
  ],
  [
    "server/src/services/workflow/run-terminal-boundary.ts",
    "LEGACY|런 종결 경계 상태 전이 2곳",
  ],
  [
    "server/src/services/workflow/run-recovery-authority.ts",
    "LEGACY|종결 런 복구(recoverTerminalRun) 상태 전이",
  ],
  [
    "server/src/services/workflow/workflow-cancel-bridge.ts",
    "LEGACY|미션/워크플로 취소 브리지 전이 2곳",
  ],
  [
    "server/src/services/workflow/workflow-child-start-lease.ts",
    "LEGACY|자식 런 시작 리스 획득/해제 2곳",
  ],
  [
    "server/src/services/workflow/workflow-child-start-state.ts",
    "LEGACY|자식 런 시작 상태 전이",
  ],
  [
    "server/src/services/workflow/workflow-child-start-failure.ts",
    "LEGACY|자식 런 시작 실패 전이",
  ],
  [
    "server/src/services/workflow/workflow-child-direct-cancel.ts",
    "LEGACY|자식 런 직접 취소 전이",
  ],
  [
    "server/src/services/workflow/workflow-child-native-finalization.ts",
    "LEGACY|자식 런 native 종결 전이",
  ],
  [
    "server/src/services/workflow/plain-start-claim.ts",
    "LEGACY|plain 시작 클레임(running 전이)",
  ],
  [
    "server/src/services/workflow/owner-plan-workflow-run.ts",
    "LEGACY|owner-plan 런 메타데이터 갱신 2곳(상태 아닌 metadata 쓰기 포함)",
  ],
  [
    "server/src/services/workflow/replacement-first-delivery.ts",
    "LEGACY|대체 첫 전달 시 metadata 갱신",
  ],
  [
    "server/src/services/workflow/resume/apply.ts",
    "LEGACY|재개(resume) 적용 상태 전이",
  ],
  [
    "server/src/services/workflow/retry-issue-less-manual.ts",
    "LEGACY|수동 재시도(running 재개) 전이",
  ],
  [
    "server/src/services/workflow/step-retry-scheduler.ts",
    "LEGACY|스텝 재시도 스케줄러 전이",
  ],
  [
    "server/src/services/workflow/source-issue-failed-state-restore.ts",
    "LEGACY|원본 이슈 실패 상태 복원",
  ],
  [
    "server/src/services/workflow/workflow-step-materialization.ts",
    "LEGACY|스텝 구체화(materialization) 전이",
  ],
]);

// ---------------------------------------------------------------------------
// 탐지기 — 파일 내용 → 위반 목록(순수 함수, self-test 가 같은 경로를 쓴다)
// ---------------------------------------------------------------------------

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** import/export … { heartbeatRuns as foo } 별칭을 수집한다. */
function collectTableAliases(content) {
  const aliases = [];
  const importRe = /\b(?:import|export)\s*(?:type\s*)?\{([^}]*)\}\s*from\s*["'][^"']+["']/g;
  for (const match of content.matchAll(importRe)) {
    for (const spec of match[1].split(",")) {
      const parts = spec.trim().split(/\s+as\s+/);
      if (parts.length === 2 && CANONICAL_TABLES.includes(parts[0].trim())) {
        const alias = parts[1].trim();
        if (/^[A-Za-z_$][\w$]*$/.test(alias)) aliases.push(alias);
      }
    }
  }
  return aliases;
}

function lineAt(content, index) {
  let line = 1;
  for (let i = 0; i < index; i += 1) {
    if (content.charCodeAt(i) === 10) line += 1;
  }
  return line;
}

/**
 * 하나의 소스 파일에서 금지된 쓰기를 찾는다.
 * 탐지 형태:
 *   1) drizzle: .update(heartbeatRuns) / .update(workflowRuns) / .update(schema.heartbeatRuns)
 *      (+ import 별칭, 멀티라인 `.update(\n  workflowRuns\n)` 포함)
 *   2) raw SQL 리터럴: update heartbeat_runs … / update workflow_runs …
 *   3) drizzle sql 템플릿: update ${heartbeatRuns} …
 */
function detectWritesInContent(content, tableNames) {
  const names = [...new Set([...CANONICAL_TABLES, ...tableNames])].map(escapeRegExp).join("|");
  const drizzleUpdateRe = new RegExp(`\\.update\\(\\s*(?:[A-Za-z_$][\\w$]*\\s*\\.\\s*)?(?:${names})\\s*,?\\s*\\)`, "g");
  const rawSqlRe = new RegExp(`\\bupdate\\s+(?:heartbeat_runs|workflow_runs)\\b`, "i");
  const rawSqlInterpRe = new RegExp(`\\bupdate\\s+\\$\\{\\s*(?:${names})\\s*\\}`, "i");

  const findings = [];
  for (const match of content.matchAll(drizzleUpdateRe)) {
    findings.push({ line: lineAt(content, match.index), snippet: match[0] });
  }
  for (const re of [rawSqlRe, rawSqlInterpRe]) {
    const match = content.match(re);
    if (match && match.index !== undefined) {
      findings.push({ line: lineAt(content, match.index), snippet: match[0] });
    }
  }
  return findings;
}

/** 파일 맵(경로→내용)에 대한 위반 목록. 테스트 경로는 제외, 허용 목록은 통과. */
function detectViolations(files) {
  const violations = [];
  for (const [path, content] of files) {
    if (isTestPath(path)) continue;
    const findings = detectWritesInContent(content, collectTableAliases(content));
    if (findings.length === 0) continue;
    if (WRITE_ALLOWLIST.has(path)) continue;
    violations.push({ path, findings });
  }
  return violations;
}

// ---------------------------------------------------------------------------
// self-test — 합성 bypass 사례로 가드가 반드시 실패함을 증명한다.
// ---------------------------------------------------------------------------
function runSelfTest({ error = console.error, log = console.log } = {}) {
  const cases = [
    {
      label: "신규 파일의 직접 .update(heartbeatRuns) 탐지",
      files: new Map([
        ["server/src/services/new-bypass.ts", "await db.update(heartbeatRuns).set({ status: 'cancelled' });"],
      ]),
      expectViolation: true,
    },
    {
      label: "import 별칭 우회 탐지(heartbeatRuns as runs)",
      files: new Map([
        [
          "server/src/services/alias-bypass.ts",
          "import { heartbeatRuns as runs } from '@paperclipai/db';\nawait tx.update(runs).set({ status: 'failed' });",
        ],
      ]),
      expectViolation: true,
    },
    {
      label: "raw SQL UPDATE 우회 탐지(update workflow_runs)",
      files: new Map([
        [
          "server/src/services/rawsql-bypass.ts",
          "await db.execute(sql`update workflow_runs set status = 'cancelled' where id = ${id}`);",
        ],
      ]),
      expectViolation: true,
    },
    {
      label: "sql 템플릿 테이블 보간 우회 탐지(update ${workflowRuns})",
      files: new Map([
        [
          "server/src/services/interp-bypass.ts",
          "await db.execute(sql`update ${workflowRuns} set status = 'cancelled'`);",
        ],
      ]),
      expectViolation: true,
    },
    {
      label: "멀티라인 .update(\\n  workflowRuns\\n) 우회 탐지",
      files: new Map([
        [
          "server/src/services/multiline-bypass.ts",
          "await db\n  .update(\n    workflowRuns,\n  )\n  .set({ status: 'cancelled' });",
        ],
      ]),
      expectViolation: true,
    },
    {
      label: "스키마 경유 쓰기 탐지(db.update(schema.heartbeatRuns))",
      files: new Map([
        [
          "server/src/services/dotted-bypass.ts",
          "await db.update(schema.heartbeatRuns).set({ status: 'cancelled' });",
        ],
      ]),
      expectViolation: true,
    },
    {
      label: "허용 목록 파일(CHOKEPOINT)은 통과",
      files: new Map([
        [
          "server/src/services/heartbeat-queue-lifecycle.ts",
          "await db.update(heartbeatRuns).set({ status: 'succeeded' });",
        ],
      ]),
      expectViolation: false,
    },
    {
      label: "테스트 경로는 제외(server/src/__tests__/x.test.ts)",
      files: new Map([
        [
          "server/src/__tests__/write-bypass.test.ts",
          "await db.update(heartbeatRuns).set({ status: 'cancelled' });",
        ],
      ]),
      expectViolation: false,
    },
    {
      label: "SELECT 는 무관(db.select().from(heartbeatRuns))",
      files: new Map([
        [
          "server/src/services/benign-select.ts",
          "const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));",
        ],
      ]),
      expectViolation: false,
    },
  ];

  let failed = 0;
  for (const testCase of cases) {
    const violations = detectViolations(testCase.files);
    const flagged = violations.some((v) => v.path === [...testCase.files.keys()][0]);
    if (flagged !== testCase.expectViolation) {
      failed += 1;
      error(`  ✗ ${testCase.label} — expected violation=${testCase.expectViolation}, got ${flagged}`);
    } else {
      log(`  ✓ ${testCase.label}`);
    }
  }

  if (failed > 0) {
    error(`\nSelf-test FAILED: ${failed} case(s) did not match expectations.`);
    return 1;
  }
  log("\nSelf-test PASSED: synthetic bypasses are detected, allowlisted/test paths pass.");
  return 0;
}

// ---------------------------------------------------------------------------
// 파일시스템 스캔 + main
// ---------------------------------------------------------------------------

function collectSourceFiles(root, dir = root, accumulator = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    let stats;
    try {
      stats = statSync(full);
    } catch {
      continue;
    }
    if (stats.isDirectory()) {
      collectSourceFiles(root, full, accumulator);
    } else if (SOURCE_EXTENSIONS.has(entry.slice(entry.lastIndexOf(".")))) {
      accumulator.push(full);
    }
  }
  return accumulator;
}

function main() {
  if (process.argv.includes("--self-test")) {
    process.exit(runSelfTest());
  }

  const repoRoot = resolve(fileURLToPath(import.meta.url), "..", "..");
  const files = new Map();
  for (const full of collectSourceFiles(repoRoot)) {
    const path = relative(repoRoot, full).split("\\").join("/");
    if (isTestPath(path)) continue;
    files.set(path, readFileSync(full, "utf8"));
  }

  const violations = detectViolations(files);

  // 허용 목록 위생: 더 이상 해당 쓰기가 없는 항목은 정리 대상 안내(실패 아님).
  const hitPaths = new Set(
    [...files]
      .filter(([, content]) => detectWritesInContent(content, collectTableAliases(content)).length > 0)
      .map(([path]) => path),
  );
  for (const path of WRITE_ALLOWLIST.keys()) {
    if (!hitPaths.has(path)) {
      console.warn(`  ⚠ allowlist entry has no matching writes (prune when converged): ${path}`);
    }
  }

  if (violations.length > 0) {
    console.error("ERROR: direct run-status writes outside the designated write modules:\n");
    for (const violation of violations) {
      for (const finding of violation.findings) {
        console.error(`  ${violation.path}:${finding.line}  ${finding.snippet}`);
      }
    }
    console.error(
      "\nheartbeat_runs/workflow_runs 상태 쓰기는 인가된 초크포인트로 가야 합니다:\n" +
        "  - heartbeat_runs: setHeartbeatRunStatus (server/src/services/heartbeat-queue-lifecycle.ts)\n" +
        "  - heartbeat-finalization/* 종결화 기록 계층\n" +
        "  기존 LEGACY 사이트를 이동한 것이 아니라면 새 쓰기 사이트를 추가할 수 없습니다.\n" +
        "  예외가 필요하면 scripts/check-run-status-write-chokepoint.mjs 의 WRITE_ALLOWLIST 에\n" +
        "  경로와 한 줄 사유를 명시하고 리뷰에서 정당화하세요.",
    );
    process.exit(1);
  }

  console.log(`  ✓  Run-status write chokepoint OK (${files.size} source files scanned, ${WRITE_ALLOWLIST.size} allowlisted).`);
}

const isMainModule = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  main();
}
