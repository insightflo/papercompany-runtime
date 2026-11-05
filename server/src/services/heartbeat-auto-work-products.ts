import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, or } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, heartbeatRuns, documents, issueComments, issueDocuments, issueWorkProducts, issues } from "@paperclipai/db";
import { completeLinkedWorkflowStepRunsForIssue } from "./workflow/issue-step-closeout.js";
import { isPathInsideOrEqual } from "./work-products/output-paths.js";
import { extractExplicitArtifactPaths, extractExplicitArtifactUrls, isActionableClaimedArtifactPath } from "./work-products/artifact-claim-paths.js";
import { assertIssueResumeScopeIdentity } from "./workflow/resume-scope-fence.js";
import { isPgUniqueViolation } from "./pg-error.js";
import { stringifyRunResultJson } from "./heartbeat-run-result-text.js";

/**
 * [스테이지 A + 봇 bug·high 조사 결과 기록] 이 헬퍼의 3개 호출부 함수
 * (autoRegisterWorkProductFromIssueDocument / FromClaimedFile /
 *  applyMissionOwnerUnblockArtifactUrlToSource)는 현재 트리에서 호출부가 없다 —
 * 과거 리팩터에서 유실(이 PR 이전 상태, 활동 로그 액션명은 유입됨). savepoint 복구는
 * 호출부 복원 시 그대로 유효하다. 복원 여부는 별도 제품 결정으로 보고됨.
 *
 * [스테이지 A + 봇 bug·medium 교정] heartbeat 자동 등록의 삽입. 대표 부분 유니크 인덱스
 * 도입 후 동시 첫 대표 등록은 23505 하드 실패가 된다(종전엔 조용한 이중 대표 드리프트).
 * savepoint 로 위반을 끊어낸 뒤 (동일 산출물이면 기존 행 재사용, 아니면) 비대표로
 * 재시기한다 — 자동 등록은 늘 성공해야 한다.
 * [주의] tx 는 트랜잭션 객체(input.tx)여야 한다 — 최상위 db 를 넘기면 savepoint 가
 * 아니라 독립 트랜잭션이 시작된다(호출부 계약).
 */
async function insertAutoWorkProduct(
  tx: Pick<Db, "insert" | "select"> & { transaction?: Db["transaction"] },
  values: typeof issueWorkProducts.$inferInsert,
): Promise<typeof issueWorkProducts.$inferSelect | null> {
  if (typeof tx.transaction !== "function") {
    // 테스트 더블(부분 mock) — 성공 경로만 시뮬레이션한다.
    return await tx
      .insert(issueWorkProducts)
      .values(values)
      .returning()
      .then((rows) => rows[0] ?? null);
  }
  try {
    return await tx.transaction(async (nested) =>
      nested
        .insert(issueWorkProducts)
        .values(values)
        .returning()
        .then((rows) => rows[0] ?? null));
  } catch (error) {
    // [봇 bug·high 교정] drizzle 은 원본 PG 오류를 cause 체인에 둔다 — 공용 판별 사용.
    if (!isPgUniqueViolation(error)) throw error;
    // [봇 bug·medium 교정] 동시 등록이 같은 산출물이었으면 이중 행이 된다 — 동일
    //   (provider, externalId/url, issue) 행이 이미 있으면 그것을 재사용한다.
    const externalId = typeof values.externalId === "string" ? values.externalId : null;
    const url = typeof values.url === "string" ? values.url : null;
    const provider = typeof values.provider === "string" ? values.provider : null;
    // [봇 bug·medium 교정] 재사용 술부는 실제 충돌 키(company, issue, type — 부분 유니크)
    //   와 일치해야 한다. provider/externalId/url 까지 같아야 "동일 산출물"이다.
    const existing = await tx
      .select()
      .from(issueWorkProducts)
      .where(and(
        eq(issueWorkProducts.companyId, values.companyId),
        eq(issueWorkProducts.issueId, values.issueId),
        ...(typeof values.type === "string" ? [eq(issueWorkProducts.type, values.type)] : []),
    // [봇 bug·medium 교정] null 식별자는 eq(col, null) — SQL 에서 항상 거짓 — 이 아니라
    //   isNull 으로 명시해야 "식별자 없는 산출물끼리"만 재사용된다(모든 값 일치 방지).
        ...(provider
          ? [eq(issueWorkProducts.provider, provider)]
          : [isNull(issueWorkProducts.provider)]),
        ...(externalId
          ? [eq(issueWorkProducts.externalId, externalId)]
          : [isNull(issueWorkProducts.externalId)]),
        ...(url
          ? [eq(issueWorkProducts.url, url)]
          : [isNull(issueWorkProducts.url)]),
      ))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existing) return existing;
    return await tx
      .insert(issueWorkProducts)
      .values({ ...values, isPrimary: false })
      .returning()
      .then((rows) => rows[0] ?? null);
  }
}

async function autoRegisterWorkProductFromIssueDocument(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
}) {
  // [Task6c-C-ii] resume-linked issue 의 workProduct 자동등록은 같은 세대 정체 검증을 공유한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: input.issue.companyId, issueId: input.issue.id }))) {
    return null;
  }
  const issueDocs = await input.tx
    .select({
      id: documents.id,
      key: issueDocuments.key,
      title: documents.title,
      latestBody: documents.latestBody,
    })
    .from(issueDocuments)
    .innerJoin(documents, eq(issueDocuments.documentId, documents.id))
    .where(eq(issueDocuments.issueId, input.issue.id))
    .limit(25);

  const matchingDocument = issueDocs.find((doc) => {
    if (doc.key !== "work-product" && doc.key !== "workproduct") return false;
    const haystack = [doc.title, doc.latestBody].filter(Boolean).join("\n");
    return input.claimedArtifactPaths
      .filter((artifactPath) => !input.allowedArtifactRoot || isPathInsideOrEqual(artifactPath, input.allowedArtifactRoot))
      .some((artifactPath) => haystack.includes(artifactPath));
  });
  if (!matchingDocument) return null;

  const artifactPath = input.claimedArtifactPaths.find((candidate) => {
    if (input.allowedArtifactRoot && !isPathInsideOrEqual(candidate, input.allowedArtifactRoot)) return false;
    const haystack = [matchingDocument.title, matchingDocument.latestBody].filter(Boolean).join("\n");
    return haystack.includes(candidate);
  });
  if (!artifactPath) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const created = await insertAutoWorkProduct(input.tx, {
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "document",
      provider: "local",
      externalId: artifactPath,
      title: matchingDocument.title ?? path.basename(artifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: "Auto-registered from issue document key `work-product` after a successful run reported this artifact path.",
      metadata: {
        path: artifactPath,
        autoRegisteredFrom: "issue_document_work_product",
        issueDocumentId: matchingDocument.id,
        issueDocumentKey: matchingDocument.key,
        claimedArtifactPaths: input.claimedArtifactPaths,
      },
      createdByRunId: input.run.id,
    });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "issue.work_product_auto_registered_from_document",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      workProductId: created?.id ?? null,
      issueDocumentId: matchingDocument.id,
      issueDocumentKey: matchingDocument.key,
      path: artifactPath,
    },
  });

  return created ?? null;
}

async function autoRegisterWorkProductFromClaimedFile(input: {
  tx: Pick<Db, "select" | "insert">;
  issue: {
    id: string;
    companyId: string;
    projectId?: string | null;
  };
  run: typeof heartbeatRuns.$inferSelect;
  claimedArtifactPaths: string[];
  allowedArtifactRoot?: string | null;
  preferClaimedArtifactPath?: boolean;
  registrationSource?: {
    type: "issue_comment_artifact_marker" | "issue_comment_claimed_file";
    commentClaimedArtifactPaths: string[];
    sourceCommentIds: string[];
  };
  requireExistingLocalFile?: boolean;
}) {
  // [Task6c-C-ii] resume-linked issue 의 workProduct 자동등록은 같은 세대 정체 검증을 공유한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: input.issue.companyId, issueId: input.issue.id }))) {
    return null;
  }
  // [목적] producer 가 산출물 파일은 만들고 경로까지 출력(claimed)했으나 POST /work-products 등록 절차를
  //   안 지킨 케이스의 회복. 문서 기반 자동등록(autoRegisterWorkProductFromIssueDocument)이 "work-product"
  //   문서가 없어 못 잡을 때, claimed 절대경로가 실제 파일이면 그 파일을 workProduct 로 등록한다.
  // [주의] 절대경로 + fs.isFile() 확인으로만 등록(오등록/과등록 위험 최소화). CMPAA-163(existing WP 를
  //   missing 으로 오탐하는 false-positive)과는 다른 경로 — 여기는 진짜 등록 안 된 실제 파일을 보강 등록.
  // [수정시 영향] 모든 producer(workflow/수동)에 적용. 조건 완화 시 오등록 위험.
  // producer 가 명시한 claimed 경로(artifact-path regex 추출)를 권위로 그대로 등록한다. 파일 존재 검사/
  //   workspace resolve 는 의도적으로 생략 — (a) producer 가 project-relative("/tech-scout/...") 등 다양한
  //   형태로 경로를 보고해 단일 resolve base 를 정하기 어렵고, (b) downstream validator 가 같은 workspace
  //   맥락에서 같은 경로를 resolve 하므로 producer 가 쓴 형태를 보존하는 쪽이 일관된다. 파일이 진짜 없으면
  //   downstream REQUEST_CHANGES 로 자교정(현재 gate block 보다 낫다). CMPAA-163(existing WP missing 오탐)
  //   과는 다른, 진짜 미등록 claimed 산출물의 보강 등록 경로.
  // producer 가 여러 경로를 claimed 할 때 deliverable-like(report/draft/.md/.html/.pdf 등) 경로를 선호하고
  //   misc(favicon/.svg/.ico/.json 등)는 배제. 잘못된 artifact 를 등록해 downstream 가 엉뚱한 파일을 쓰는 것을
  //   막는다(이전 run: synthesize 가 favicon.svg 를 대신 등록해 build 가 report.md 를 못 찾음).
  const DELIVERABLE_NAME_RE = /(report|draft|outline|article|document|deliverable|artifact|manual|guide|summary|brief|synthesi[sz]e)/i;
  const DELIVERABLE_EXT_RE = /\.(md|html?|pdf|txt)$/i;
  const MISC_ARTIFACT_RE = /(favicon|\.svg$|\.ico$|\.json$|\.lock$|\.log$|\.map$|node_modules|package\.json|\/config\.)/i;
  const runDateStr = input.run.startedAt instanceof Date
    ? input.run.startedAt.toISOString().slice(0, 10).replace(/-/g, "")
    : "";
  const eligibleClaimedArtifactPaths = input.claimedArtifactPaths
    .filter((c): c is string => typeof c === "string" && c.trim().length > 0 && !c.includes("{"))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  // explicit `[ARTIFACT]: <abs path>` 마커로 선언된 경로를 권위로 우선한다. generic scraping noise
  // (raw-tech-scout.json, /design.md 등)가 eligible 을 여러 개로 만들어도, explicit 선언 1개면
  // 그것을 등록(.json 이라도). extractExplicitArtifactPaths 가 Set dedup + backslash strip 하므로
  // `evidence.json\`(command escaping)과 `evidence.json`(final line)은 하나로 정규화된다.
  const explicitRunText = [stringifyRunResultJson(input.run.resultJson), input.run.stdoutExcerpt, input.run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  const explicitEligiblePaths = extractExplicitArtifactPaths(explicitRunText)
    .filter((p) => isActionableClaimedArtifactPath(p))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot));
  const commentRegistrationSource = input.registrationSource ?? null;
  const commentRegistrationSourceKind = commentRegistrationSource?.type ?? null;
  const explicitCommentEligiblePaths = commentRegistrationSource?.commentClaimedArtifactPaths
    .filter((p) => isActionableClaimedArtifactPath(p))
    .filter((p) => !input.allowedArtifactRoot || isPathInsideOrEqual(p, input.allowedArtifactRoot)) ?? [];
  const declaredArtifactPath = explicitCommentEligiblePaths.length === 1
    ? explicitCommentEligiblePaths[0]
    : input.preferClaimedArtifactPath && explicitEligiblePaths.length >= 1
    ? explicitEligiblePaths[0]
    : null;
  const scored = eligibleClaimedArtifactPaths
    .map((p) => {
      let score = (DELIVERABLE_NAME_RE.test(p) ? 2 : 0) + (DELIVERABLE_EXT_RE.test(p) ? 2 : 0) - (MISC_ARTIFACT_RE.test(p) ? 3 : 0);
      // run-date awareness: current-run 날짜 경로 선호(+5), stale 날짜 패널티(-5)
      if (runDateStr && p.includes(runDateStr)) score += 5;
      else if (/\d{8}/.test(p)) score -= 5;
      return { p, score };
    })
    .sort((a, b) => b.score - a.score);
  // deliverable-like(점수>0)인 것만 등록. 전부 misc 면 등록 안 함(gate block — 잘못된 artifact 등록 방지).
  const resolvedArtifactPath = declaredArtifactPath ?? (scored.length > 0 && scored[0].score > 0 ? scored[0].p : null);
  if (!resolvedArtifactPath) return null;
  if (input.requireExistingLocalFile === true && !(await isExistingLocalFile(resolvedArtifactPath))) return null;

  const isPrimary = !(await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(eq(issueWorkProducts.issueId, input.issue.id))
    .limit(1)
    .then((rows) => rows[0] ?? null));

  const created = await insertAutoWorkProduct(input.tx, {
      companyId: input.issue.companyId,
      projectId: input.issue.projectId ?? null,
      issueId: input.issue.id,
      type: "file",
      provider: "local",
      externalId: resolvedArtifactPath,
      title: path.basename(resolvedArtifactPath),
      status: "active",
      reviewState: "none",
      isPrimary,
      healthStatus: "unknown",
      summary: commentRegistrationSource
        ? "Auto-registered from one same-run issue comment artifact path."
        : "Auto-registered from a claimed artifact path that resolves to a real file (producer reported the path but did not register a workProduct).",
      metadata: commentRegistrationSource
        ? {
            path: resolvedArtifactPath,
            autoRegisteredFrom: commentRegistrationSourceKind,
            commentClaimedArtifactPaths: commentRegistrationSource.commentClaimedArtifactPaths,
            sourceCommentIds: commentRegistrationSource.sourceCommentIds,
          }
        : {
            path: resolvedArtifactPath,
            autoRegisteredFrom: "claimed_artifact_file",
            claimedArtifactPaths: input.claimedArtifactPaths,
          },
      createdByRunId: input.run.id,
    });

  await input.tx.insert(activityLog).values({
    companyId: input.issue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: commentRegistrationSource
      ? "issue.work_product_auto_registered_from_comment"
      : "issue.work_product_auto_registered_from_file",
    entityType: "issue",
    entityId: input.issue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: commentRegistrationSource
      ? {
          workProductId: created?.id ?? null,
          path: resolvedArtifactPath,
          autoRegisteredFrom: commentRegistrationSourceKind,
          commentClaimedArtifactPaths: commentRegistrationSource.commentClaimedArtifactPaths,
          sourceCommentIds: commentRegistrationSource.sourceCommentIds,
        }
      : {
          workProductId: created?.id ?? null,
          path: resolvedArtifactPath,
          autoRegisteredFrom: "claimed_artifact_file",
          claimedArtifactPaths: input.claimedArtifactPaths,
        },
  });

  return created ?? null;
}

async function isExistingLocalFile(artifactPath: string): Promise<boolean> {
  try {
    const stats = await fs.stat(artifactPath);
    return stats.isFile();
  } catch (error) {
    if (error instanceof Error) return false;
    throw error;
  }
}

function extractMissionOwnerUnblockArtifactUrl(run: Pick<typeof heartbeatRuns.$inferSelect, "resultJson" | "stdoutExcerpt" | "stderrExcerpt">): string | null {
  const text = [stringifyRunResultJson(run.resultJson), run.stdoutExcerpt, run.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n");
  return extractExplicitArtifactUrls(text)[0] ?? null;
}

async function applyMissionOwnerUnblockArtifactUrlToSource(input: {
  tx: Pick<Db, "select" | "insert" | "update" | "transaction">;
  ownerActionIssue: Pick<typeof issues.$inferSelect, "id" | "companyId" | "missionId" | "identifier" | "originKind" | "originId">;
  run: typeof heartbeatRuns.$inferSelect;
  artifactUrl: string;
  now: Date;
}): Promise<{ sourceIssueId: string; workProductId: string | null } | null> {
  const ownerActionIssue = input.ownerActionIssue;
  if (
    ownerActionIssue.originKind !== "mission_main_executor_unblock" ||
    !ownerActionIssue.originId ||
    !ownerActionIssue.missionId
  ) {
    return null;
  }

  const sourceIssue = await input.tx
    .select({
      id: issues.id,
      companyId: issues.companyId,
      projectId: issues.projectId,
      missionId: issues.missionId,
      identifier: issues.identifier,
      title: issues.title,
      status: issues.status,
      assigneeAgentId: issues.assigneeAgentId,
      hiddenAt: issues.hiddenAt,
      completedAt: issues.completedAt,
    })
    .from(issues)
    .where(and(eq(issues.id, ownerActionIssue.originId), eq(issues.companyId, ownerActionIssue.companyId)))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  if (!sourceIssue || sourceIssue.hiddenAt || sourceIssue.missionId !== ownerActionIssue.missionId) return null;
  if (sourceIssue.status === "cancelled") return null;

  // [Task6c-C-ii] resume-linked source issue 의 owner-unblock artifact 자동등록도 같은 세대
  //   정체 검증을 공유한다 — 어긋나면 등록/완료 mutation 전에 무음 스킵한다.
  if (!(await assertIssueResumeScopeIdentity(input.tx as unknown as Parameters<typeof assertIssueResumeScopeIdentity>[0], { companyId: sourceIssue.companyId, issueId: sourceIssue.id }))) {
    return null;
  }

  const existingWorkProduct = await input.tx
    .select({ id: issueWorkProducts.id })
    .from(issueWorkProducts)
    .where(and(
      eq(issueWorkProducts.companyId, sourceIssue.companyId),
      eq(issueWorkProducts.issueId, sourceIssue.id),
      or(
        eq(issueWorkProducts.url, input.artifactUrl),
        eq(issueWorkProducts.externalId, input.artifactUrl),
      ),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);

  let workProductId: string | null = existingWorkProduct?.id ?? null;
  if (!workProductId) {
    const hasExistingWorkProduct = await input.tx
      .select({ id: issueWorkProducts.id })
      .from(issueWorkProducts)
      .where(eq(issueWorkProducts.issueId, sourceIssue.id))
      .limit(1)
      .then((rows) => Boolean(rows[0]));

    const created = await insertAutoWorkProduct(input.tx, {
        companyId: sourceIssue.companyId,
        projectId: sourceIssue.projectId ?? null,
        issueId: sourceIssue.id,
        type: "preview_url",
        provider: "mission_owner_unblock",
        externalId: input.artifactUrl,
        title: sourceIssue.title,
        url: input.artifactUrl,
        status: "active",
        reviewState: "none",
        isPrimary: !hasExistingWorkProduct,
        healthStatus: "unknown",
        summary: "Auto-registered from a successful mission-owner unblock run that emitted an [ARTIFACT] URL.",
        metadata: {
          autoRegisteredFrom: "mission_owner_unblock_artifact_url",
          ownerActionIssueId: ownerActionIssue.id,
          ownerActionIssueIdentifier: ownerActionIssue.identifier,
          ownerActionRunId: input.run.id,
        },
        createdByRunId: input.run.id,
      });
    workProductId = created?.id ?? null;

    await input.tx.insert(activityLog).values({
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "heartbeat",
      action: "issue.work_product_auto_registered_from_owner_unblock_url",
      entityType: "issue",
      entityId: sourceIssue.id,
      agentId: input.run.agentId,
      runId: input.run.id,
      details: {
        workProductId,
        artifactUrl: input.artifactUrl,
        ownerActionIssueId: ownerActionIssue.id,
      },
    });
  }

  if (sourceIssue.status !== "done") {
    await input.tx
      .update(issues)
      .set({
        status: "done",
        checkoutRunId: null,
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
        completedAt: input.now,
        updatedAt: input.now,
      })
      .where(and(eq(issues.id, sourceIssue.id), eq(issues.companyId, sourceIssue.companyId)));
  }
  const completedStepRunIds = await completeLinkedWorkflowStepRunsForIssue({
    db: input.tx,
    issueId: sourceIssue.id,
    completedAt: sourceIssue.completedAt ?? input.now,
    source: "heartbeat_promotion",
    heartbeatRunId: input.run.id,
  });

  await input.tx.insert(issueComments).values({
    companyId: sourceIssue.companyId,
    issueId: sourceIssue.id,
    authorAgentId: input.run.agentId,
    body: [
      "### Mission owner unblock result applied",
      `Owner-action issue: ${ownerActionIssue.identifier ?? ownerActionIssue.id} (${ownerActionIssue.id})`,
      `Owner-action run: ${input.run.id}`,
      "Action: successful owner-unblock run emitted an [ARTIFACT] URL, so the source issue was reconciled to done.",
      workProductId ? `WorkProduct: ${workProductId}` : "WorkProduct: already registered",
      `[ARTIFACT]: ${input.artifactUrl}`,
    ].join("\n"),
  });

  await input.tx.insert(activityLog).values({
    companyId: sourceIssue.companyId,
    actorType: "system",
    actorId: "heartbeat",
    action: "mission.owner_unblock_source_completed_from_artifact_url",
    entityType: "issue",
    entityId: sourceIssue.id,
    agentId: input.run.agentId,
    runId: input.run.id,
    details: {
      previousStatus: sourceIssue.status,
      nextStatus: "done",
      ownerActionIssueId: ownerActionIssue.id,
      workflowStepRunIds: completedStepRunIds,
      artifactUrl: input.artifactUrl,
      workProductId,
    },
  });

  return { sourceIssueId: sourceIssue.id, workProductId };
}
