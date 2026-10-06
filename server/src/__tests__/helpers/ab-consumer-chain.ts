// server/src/__tests__/helpers/ab-consumer-chain.ts
//
// [수정 변경맵 — Q3 결합 완결] mission-revision-ab-consumer GREEN-1 이 A(seed 재사용)+B(신규 수집)의
// 소비자 dispatch·toolArgs 해석·계보 증명까지 끝낸 뒤 남은 체인을 마감한다. 결합 생산자(combine)를
// 실제 승인 생산자 경로(admittedProducer + workProduct 등록)로 완료해 A 원본 bytes + B 새 산출물
// bytes 를 같은 결합 파일로 생산하고, 이미 등록된 combine-qa/combine-publish/combine-readback
// 스텝·스크립트·artifact contract 를 실제 공개 경로(syncWorkflowRunState → processQueuedWorkflowTool-
// StepRuns → 코어 도구 실행 → 완료 기록)로 실행해 [결합 A+B bytes → 이번 실행 새 검수 영수증 →
// 게시 → 확인] 이 모두 현재 실행/시도에 결합됨을 증명한다. qa-publish-readback fixture 의 완결
// 패턴(completeEditedBody + sync/queue 루프)을 그대로 따른다 — 게이트 우회·상태 위조·대체 경로 없음.
// 테스트 파일 300줄 제한 유지를 위한 분리 헬퍼다(부정 테스트는 본 파일을 건드리지 않는다).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import { issues, workflowStepRuns, type Db } from "@paperclipai/db";
import { admittedProducer } from "./admitted-producer.js";
import { workProductService } from "../../services/work-products.js";
import { processQueuedWorkflowToolStepRuns, syncWorkflowRunState } from "../../services/workflow/dag-engine.js";

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const meta = (row: typeof workflowStepRuns.$inferSelect) => (row.metadata ?? {}) as Record<string, unknown>;
type Receipt = { outputRoot: string; relativePath: string } & Record<string, unknown>;

// GREEN-1 후속: 결합 생산자 완료 → 새 검수 → 게시 → 확인(같은 실행 영수증 증명).
export async function finishAbConsumerChain(input: { db: Db; root: string; companyId: string; agentId: string;
  revision: { id: string }; target: { id: string }; aFile: string; aBytes: Buffer; bArtifact: string }) {
  const { db, root, companyId, agentId, revision, target, aFile, aBytes, bArtifact } = input;
  const rowsOf = (stepId: string) => db.select().from(workflowStepRuns)
    .where(and(eq(workflowStepRuns.workflowRunId, target.id), eq(workflowStepRuns.stepId, stepId)));
  const stepRunOf = async (stepId: string) => (await rowsOf(stepId))[0]!;
  const stepRunStatus = async (stepId: string) => (await rowsOf(stepId))[0]?.status;
  // 1) 결합 생산자 완료: 이번 실행이 발사한 combine 이슈를 실제 승인 생산자 경로로 마감하고 A+B 두
  //    bytes 를 담은 결합 파일을 현재 실행 미션 출력 루트 안에 생산한다.
  const combine = await stepRunOf("combine");
  if (!combine.issueId) throw new Error("combine was not dispatched as this run's own work item");
  const heartbeatId = randomUUID();
  await db.update(workflowStepRuns).set({ status: "running", startedAt: new Date() }).where(eq(workflowStepRuns.id, combine.id));
  await admittedProducer(db, { companyId, agentId, issueId: combine.issueId, stepRunId: combine.id, heartbeatId });
  const combineDir = path.join(root, "missions", revision.id, "combine");
  await mkdir(combineDir, { recursive: true });
  const combinedFile = path.join(combineDir, "combined.json");
  const combinedBytes = Buffer.from(JSON.stringify({ reportA: JSON.parse(aBytes.toString("utf8")),
    reportB: JSON.parse(await readFile(bArtifact, "utf8")) }));
  await writeFile(combinedFile, combinedBytes);
  const product = await workProductService(db).createForIssue(combine.issueId, companyId, { provider: "local_file",
    type: "document", title: "combined.json", status: "active", createdByRunId: heartbeatId,
    metadata: { path: combinedFile, sha256: sha(combinedBytes) } });
  expect(product?.metadata).toMatchObject({ path: combinedFile, sha256: sha(combinedBytes),
    workflowProducer: { workflowRunId: target.id, stepRunId: combine.id } }); // 결합 산출물 생산자 = 이번 실행 combine
  await db.update(issues).set({ status: "done" }).where(eq(issues.id, combine.issueId));
  await db.update(workflowStepRuns).set({ status: "completed", completedAt: new Date() }).where(eq(workflowStepRuns.id, combine.id));
  // 2) 이미 등록된 검수→게시→확인 스텝을 실제 공개 경로로 실행한다(running 실행의 executeWorkflowRun
  //    재진입은 busy no-op 이므로 실제 sync 경로로 발화 — qa-publish-readback 완결 패턴과 동일).
  for (let round = 0; round < 8 && await stepRunStatus("combine-readback") !== "completed"; round++) {
    await syncWorkflowRunState(db, target.id);
    await processQueuedWorkflowToolStepRuns(db);
  }
  const qa = await stepRunOf("combine-qa"), publish = await stepRunOf("combine-publish"),
    readback = await stepRunOf("combine-readback");
  expect([qa, publish, readback].map(s => s.status)).toEqual(["completed", "completed", "completed"]);
  // 3) 결합 bytes 증명: 결합 파일이 A 원본값과 B 새 산출값을 모두 담고 A 원본 bytes 는 불변이다.
  const combinedText = combinedBytes.toString("utf8");
  expect(combinedText).toContain('"report":"A"'); // A 실제 결합
  expect(combinedText).toContain("youtu.be/B"); // B 실제 결합
  expect(await readFile(aFile, "utf8")).toBe(aBytes.toString("utf8")); // A 원본 불변
  // 4) 새 검수 영수증 = 현재 실행·시도·combine 생산자에 결합된 실제 결합 bytes 계약.
  const receipt = meta(qa).toolArtifactReceipt as Receipt;
  expect(receipt).toMatchObject({ role: "qa", workflowRunId: target.id, stepRunId: qa.id, missionId: revision.id,
    requestId: qa.lastDispatchRequestId, executionGeneration: qa.executionGeneration, retryCount: 0, iterationIndex: 0,
    input: { path: combinedFile, sha256: sha(combinedBytes),
      producer: { workflowRunId: target.id, stepRunId: combine.id } } });
  expect(receipt.outputRoot).toContain(path.join("missions", revision.id)); // 검수 결과 루트 = 현재 실행 미션
  const freshQaBytes = await readFile(path.join(receipt.outputRoot, receipt.relativePath));
  // 5) 게시 = 결합 bytes + 이번 실행 새 검수 소비, 결과 경로·스코프 = 현재 실행·게시 스텝런·시도.
  const publicationPath = (meta(publish).toolResult as { artifactPath: string }).artifactPath;
  expect(publicationPath).toContain(path.join("missions", revision.id));
  const publication = JSON.parse(await readFile(publicationPath, "utf8"));
  expect(publication.scope).toMatchObject({ companyId, missionId: revision.id, workflowRunId: target.id,
    stepRunId: publish.id, requestId: publish.lastDispatchRequestId, executionGeneration: publish.executionGeneration });
  expect(publication.inputDigest).toMatchObject({ sha256: sha(combinedBytes), qaSha256: sha(freshQaBytes) });
  // 6) 확인 회수 = 같은 실행·확인 스텝런·시도에 결합된 결합 게시물 bytes 회수.
  const readbackPath = (meta(readback).toolResult as { artifactPath: string }).artifactPath;
  const verified = JSON.parse(await readFile(readbackPath, "utf8"));
  expect(verified).toMatchObject({ command: "verify", id: "ab-report", publicUrl: publication.publicUrl,
    scope: { workflowRunId: target.id, stepRunId: readback.id, requestId: readback.lastDispatchRequestId } });
  expect(readbackPath).toContain(path.join("missions", revision.id));
}
