import { readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { createDb } from "../packages/db/src/index.js";
import { hashStructuredValue } from "../server/src/services/issue-execution-cards/hash.js";
import {
  buildHistoricalExecutionSnapshot,
  parseReviewedHistoricalImportInput,
  REVIEWED_HISTORICAL_DEFINITION_FACTS,
} from "../server/src/services/workflow/resume/historical-import-core.js";
import { importReviewedHistoricalDefinition } from "../server/src/services/workflow/resume/historical-import.js";

/**
 * [파일 목적] reviewed historical 실행정의의 명시적 운영자 임포트 스크립트(신뢰된 로컬
 *   maintenance capability — HTTP/agent tool 이 아니다). Parent 가 감사한 단 하나의 스코프와
 *   기대 raw hash 로 제한되며, 임의 JSON 번들 승격/URL fetch/자동 프로덕션 실행은 없다.
 * [동작]
 *   - 기본(또는 --dry-run): DB 접속 없이 파일 파싱({steps} strict), 감사 hash 대조, 정규화/
 *     해시 요약만 출력한다. 쓰기 없음.
 *   - --apply: --reviewed-by 필수 + DATABASE_URL 필수(추론/기본값 금지). reviewedAt 은 지금
 *     시각의 명시적 운영자 attestation 이지 historical 사건이 아니다. 임포트는 기존 트랜잭션
 *     서비스(importReviewedHistoricalDefinition)로 수행하고 handle 을 finally 에서 닫는다.
 * [출력 계약] scope label / definitionHash / sourceStepsHash / stepCount / imported|replayed
 *   만 출력한다. DB 자격증명·파일 내용·payload 는 출력하지 않는다.
 * [운영] 대상 스코프는 production 이다. 이 슬라이스에서 --apply 는 실행하지 않았다(기록만).
 */

const AUDITED_SCOPE = Object.freeze({
  companyId: "ff3e3efd-e30c-45c2-b893-497164405629",
  missionId: "dadedefd-5e18-405b-9e4a-06c22907f039",
  workflowRunId: "68566a4d-6670-427e-9b0e-07c382864e01",
  workflowId: "78fa7646-25fd-4607-aebf-53a91273f59e",
});

const EXPECTED_SOURCE_STEPS_HASH = "0a29edd8dfa88a4e28d8f4decf33c4a738c659a46800bef08a016ed9b63a4132";

/** Parent-audited historical tool-trace 참조(고정 상수 — 파일 내용 절대 아님). */
const REVIEW_SOURCE_RECORD = "session:2026-08-15T06-56-17-363Z_01a00434-ffd3-7e2c-bded-7e36fb43bc24.jsonl"
  + " tool-lines:25544-25549 run-lines:25620-25623";

const DEFAULT_SOURCE_PATH = "/tmp/wf-steps-patch2.json";
const DRY_RUN_REVIEWED_BY = "dry-run(no-attestation)";

function argValue(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function hasFlag(name: string): boolean {
  return process.argv.includes(name);
}

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n`);
  process.exit(1);
}

/** {steps: unknown[]} 만 허용하는 strict 파서(zod 대신 수동 — 스크립트 의존 최소화). */
function parseStepsBundle(raw: string, sourcePath: string): unknown[] {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch (error) {
    fail(`source is not valid JSON: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail("source must be a JSON object with exactly {steps: [...]}, keys");
  }
  const keys = Object.keys(value as Record<string, unknown>);
  if (keys.length !== 1 || keys[0] !== "steps") {
    fail(`source must have exactly {steps}, got keys: ${keys.join(",")}`);
  }
  const steps = (value as Record<string, unknown>).steps;
  if (!Array.isArray(steps)) {
    fail("source.steps must be an array");
  }
  return steps;
}

function buildOperatorInput(steps: unknown[], reviewedBy: string, now: Date) {
  return {
    ...AUDITED_SCOPE,
    steps,
    provenance: {
      schemaVersion: 1 as const,
      origin: "reviewed_historical_import" as const,
      workflowId: AUDITED_SCOPE.workflowId,
      missionId: AUDITED_SCOPE.missionId,
      workflowName: REVIEWED_HISTORICAL_DEFINITION_FACTS.workflowName,
      source: REVIEWED_HISTORICAL_DEFINITION_FACTS.source,
      sourceKind: REVIEWED_HISTORICAL_DEFINITION_FACTS.sourceKind,
      definitionUpdatedAt: REVIEWED_HISTORICAL_DEFINITION_FACTS.definitionUpdatedAt,
      review: {
        schemaVersion: 1 as const,
        sourceStepsHash: EXPECTED_SOURCE_STEPS_HASH,
        sourceRecord: REVIEW_SOURCE_RECORD,
        reviewedBy,
        reviewedAt: now.toISOString(),
      },
    },
    now,
  };
}

function printSummary(fields: {
  definitionHash: string;
  sourceStepsHash: string;
  stepCount: number;
}): void {
  process.stdout.write(`scope: company=${AUDITED_SCOPE.companyId} mission=${AUDITED_SCOPE.missionId}`
    + ` workflow=${AUDITED_SCOPE.workflowId} run=${AUDITED_SCOPE.workflowRunId}\n`);
  process.stdout.write(`scope-label: ${REVIEWED_HISTORICAL_DEFINITION_FACTS.workflowName} (reviewed historical import)\n`);
  process.stdout.write(`definitionHash: ${fields.definitionHash}\n`);
  process.stdout.write(`sourceStepsHash: ${fields.sourceStepsHash}\n`);
  process.stdout.write(`stepCount: ${fields.stepCount}\n`);
}

async function main(): Promise<void> {
  const apply = hasFlag("--apply");
  if (argValue("--source") !== undefined && /^https?:\/\//i.test(argValue("--source") ?? "")) {
    fail("--source must be a local PATH, not a URL");
  }
  const sourcePath = path.resolve(argValue("--source") ?? DEFAULT_SOURCE_PATH);
  if (sourcePath !== path.resolve(sourcePath) || /^https?:\/\//i.test(sourcePath)) {
    fail("--source must be a local PATH, not a URL");
  }
  let raw: string;
  try {
    raw = readFileSync(sourcePath, "utf8");
  } catch (error) {
    fail(`cannot read source file: ${sourcePath}: ${error instanceof Error ? error.message : String(error)}`);
  }
  const steps = parseStepsBundle(raw, sourcePath);

  // 감사 hash 대조 — 정규화/해시 계산 그 어떤 것보다 먼저. 불일치면 대체 투입 금지(중단).
  const sourceStepsHash = hashStructuredValue(steps);
  if (sourceStepsHash !== EXPECTED_SOURCE_STEPS_HASH) {
    fail(`source steps hash mismatch: expected ${EXPECTED_SOURCE_STEPS_HASH}, got ${sourceStepsHash}`);
  }

  if (!apply) {
    // dry-run: DB 연결 자체를 만들지 않는다(파일 파싱/hash/정규화 요약만).
    const dryRunInput = buildOperatorInput(steps, DRY_RUN_REVIEWED_BY, new Date());
    const snapshot = buildHistoricalExecutionSnapshot(parseReviewedHistoricalImportInput(dryRunInput));
    process.stdout.write("mode: dry-run (no DB connection, no writes)\n");
    printSummary({
      definitionHash: snapshot.definitionHash,
      sourceStepsHash: dryRunInput.provenance.review.sourceStepsHash,
      stepCount: snapshot.stepCount,
    });
    return;
  }

  const reviewedBy = argValue("--reviewed-by");
  if (!reviewedBy || reviewedBy.trim().length === 0) {
    fail("--reviewed-by is mandatory with --apply (explicit operator attestation)");
  }
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    fail("DATABASE_URL is mandatory with --apply (no inferred production/local/default)");
  }

  const db = createDb(databaseUrl);
  try {
    const result = await importReviewedHistoricalDefinition(db, buildOperatorInput(steps, reviewedBy.trim(), new Date()));
    process.stdout.write(`mode: apply\n`);
    process.stdout.write(`result: ${result.status}\n`);
    printSummary(result);
  } finally {
    await db.$client.end({ timeout: 5 }).catch(() => {});
  }
}

function isDirectInvocation(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  return import.meta.url === pathToFileURL(path.resolve(argvPath)).href;
}

if (isDirectInvocation()) {
  await main();
}
