// server/src/services/workflow/control-flow/qa-remediation-qualification.ts

import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { EdgeBearingStep } from "./edge-condition.js";
import { isStructuralGateStep } from "./structural-gate.js";
import { isDeliveryReadbackStep } from "../delivery-verification-gate.js";
import { loadLatestQaRemediations } from "../validation-verdict-ledger.js";
import { loadProducerOwnReworkContext } from "./rework-producer-context.js";
import { isLatestQaExecution } from "./qa-cap-acceptance.js";
import {
  QA_REMEDIATION_MAX_ATTEMPTS,
  QA_REMEDIATION_MAX_FILE_BYTES,
  remediationAlreadyApplied,
  remediationAttemptCount,
  type PreparedFile,
  type QualificationResult,
  type QualifiedQa,
  type TryQaRemediationInput,
} from "./qa-remediation-contract.js";

function isHardBlockedQaStep(def: EdgeBearingStep | undefined): boolean {
  if (!def) return true;
  return (def as { capAcceptance?: string }).capAcceptance === 'blocked' || isStructuralGateStep(def as never) || isDeliveryReadbackStep(def as never);
}

/** [current-generation freshness, fail-closed] 판정 observedAt 이 producer 완료 이후여야 한다. */
function isFreshRemediation(observedAt: Date | null, producerCompletedAt: Date | null): boolean {
  if (!producerCompletedAt || !observedAt) return false;
  return observedAt.getTime() >= producerCompletedAt.getTime();
}

/** 생산자 active workProduct 절대경로 → (정확 파일 허용집, 디렉터리 허용집). */
async function loadProducerArtifactBoundary(input: Pick<TryQaRemediationInput, "db" | "run" | "producerStep" | "producerRun">): Promise<{
  allowedFiles: Set<string>;
  allowedDirs: string[];
} | null> {
  if (!input.producerRun.issueId) return null;
  const context = await loadProducerOwnReworkContext({
    db: input.db,
    companyId: input.run.companyId,
    missionId: input.run.missionId ?? null,
    workflowRunId: input.run.id,
    producerStepId: input.producerStep.id,
    producerIssueId: input.producerRun.issueId,
  });
  const allowedFiles = new Set<string>();
  const allowedDirs: string[] = [];
  for (const product of context.workProducts) {
    if (!path.isAbsolute(product.ref)) continue;
    const resolved = path.resolve(product.ref);
    allowedFiles.add(resolved);
    allowedDirs.push(path.dirname(resolved));
  }
  return allowedDirs.length > 0 ? { allowedFiles, allowedDirs } : null;
}

export function isInsideBoundary(file: string, boundary: { allowedFiles: Set<string>; allowedDirs: string[] }): boolean {
  if (!path.isAbsolute(file)) return false;
  const resolved = path.resolve(file);
  if (boundary.allowedFiles.has(resolved)) return true;
  return boundary.allowedDirs.some((dir) => {
    const rel = path.relative(dir, resolved);
    return rel.length > 0 && !rel.startsWith("..") && !path.isAbsolute(rel);
  });
}

/** [T3 추출] 자격검사+경계+two-phase 검증까지만 — 깨우기/기록은 하지 않는다(두 경로 공유). */
export async function collectQualifiableQaRemediations(input: TryQaRemediationInput): Promise<QualificationResult> {
  const { db, run } = input;
  if (run.status === "cancelled") return { status: "not_applicable", detail: "run cancelled" };
  if (input.rejectedQas.length === 0) return { status: "not_applicable", detail: "no rejected qas" };

  const qualified: QualifiedQa[] = [];
  let waitingCount = 0;
  for (const q of input.rejectedQas) {
    const qaRun = q.qaRun;
    if (!qaRun || !qaRun.issueId) return { status: "not_applicable", detail: "rejected qa missing issue binding" };

    // 구조/납품 게이트 하드 블록(fail-closed) — 결정론적 게이트를 패치로 우회할 수 없다.
    const qaStepDef = input.steps.find((s) => s.id === q.edge.stepId);
    if (isHardBlockedQaStep(qaStepDef)) return { status: "not_applicable", detail: `hard-blocked qa step ${q.edge.stepId}` };

    // 원천 데이터 결함이 섞여 있으면 기계적 산출물 수정으로 해결 불가 — 생산자 재작업/오너 라우팅에 맡긴다.
    const findings = input.findingsByQaStepId.get(q.edge.stepId) ?? null;
    if (findings?.some((finding) => finding.layer === "source_data")) {
      return { status: "not_applicable", detail: `qa ${q.edge.stepId} carries source_data findings` };
    }

    const loaded = await loadLatestQaRemediations({ db, companyId: run.companyId, issueId: qaRun.issueId });
    if (!loaded) return { status: "not_applicable", detail: `qa ${q.edge.stepId} has no applicable remediations` };
    // exact current QA step-run binding: 이전 세대 verdict 의 remediation 은 절대 적용하지 않는다.
    if (!loaded.workflowStepRunId || loaded.workflowStepRunId !== qaRun.id) {
      return { status: "not_applicable", detail: `qa ${q.edge.stepId} remediation bound to foreign step run` };
    }
    // current producer generation 판정(unknown 시 fail-closed).
    if (!isFreshRemediation(loaded.observedAt, input.producerRun.completedAt ?? null)) {
      return { status: "not_applicable", detail: `qa ${q.edge.stepId} remediation not fresh for producer generation` };
    }
    // [execution freshness] verdict heartbeat 가 이 QA step 의 최신 실행이어야 한다(재발행 이후 판정 스킵).
    if (!(await isLatestQaExecution(db, qaRun.issueId, qaRun.id, loaded.heartbeatRunId))) {
      return { status: "not_applicable", detail: `qa ${q.edge.stepId} verdict superseded by newer execution` };
    }
    // [idempotency] 이 verdict event 에 대한 remediation 이 이미 적용됐다면 재적용/재작업 모두 스킵(홀드).
    if (await remediationAlreadyApplied(db, run.companyId, qaRun.id, loaded.sourceVerdictEventId)) {
      waitingCount += 1;
      continue;
    }
    // [bounded] QA stepRun 당 시도 상한 — 초과 시 생산자 재작업 경로로 폴백.
    const attempts = await remediationAttemptCount(db, run.companyId, qaRun.id);
    if (attempts >= QA_REMEDIATION_MAX_ATTEMPTS) {
      return { status: "not_applicable", detail: `qa ${q.edge.stepId} remediation attempt cap exhausted` };
    }

    qualified.push({
      qaRun,
      remediations: loaded.remediations,
      heartbeatRunId: loaded.heartbeatRunId,
      sourceVerdictEventId: loaded.sourceVerdictEventId,
    });
  }

  if (qualified.length === 0 && waitingCount === input.rejectedQas.length) {
    return { status: "waiting", detail: "all rejected qa verdicts already remediated; awaiting fresh QA verdict" };
  }

  // boundary: 생산자 등록 산출물 경로/디렉터리 외부 파일은 절대 건드리지 않는다.
  const boundary = await loadProducerArtifactBoundary(input);
  if (!boundary) return { status: "not_applicable", detail: "producer has no absolute-path active work products" };

  // two-phase validate: 파일 읽기 + 순차 find 검증(정확히 한 번). 하나라도 실패하면 전체 폴백.
  const fileBuffers = new Map<string, PreparedFile>();
  for (const qa of qualified) {
    for (const item of qa.remediations.items) {
      if (!isInsideBoundary(item.file, boundary)) {
        return { status: "not_applicable", detail: `remediation file outside producer artifact boundary: ${item.file}` };
      }
      const resolved = path.resolve(item.file);
      let entry = fileBuffers.get(resolved);
      if (!entry) {
        let size: number;
        try {
          size = (await stat(resolved)).size;
        } catch {
          return { status: "not_applicable", detail: `remediation target missing: ${resolved}` };
        }
        if (size > QA_REMEDIATION_MAX_FILE_BYTES) {
          return { status: "not_applicable", detail: `remediation target too large: ${resolved}` };
        }
        try {
          const original = await readFile(resolved, "utf8");
          entry = { content: original, itemCount: 0, beforeHash: createHash("sha256").update(original).digest("hex") };
        } catch {
          return { status: "not_applicable", detail: `remediation target unreadable: ${resolved}` };
        }
        fileBuffers.set(resolved, entry);
      }
      const first = entry.content.indexOf(item.find);
      if (first === -1 || entry.content.indexOf(item.find, first + 1) !== -1) {
        return { status: "not_applicable", detail: `find not exactly-once in ${resolved} (qa ${qa.qaRun.stepId})` };
      }
      entry.content = entry.content.slice(0, first) + item.replace + entry.content.slice(first + item.find.length);
      entry.itemCount += 1;
    }
  }
  return { status: "qualified", qualified, fileBuffers };
}

