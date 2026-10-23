import { and, desc, eq, notExists } from "drizzle-orm";
import { preserveProducerMetadata, type registeredProducer } from "./work-products/producer-provenance.js";
import { workProductProducerWrite } from "./work-products/producer-write.js";
import { resolveWorkProductLocalFilePath } from "./work-products/producer-seal.js";
export { resolveWorkProductLocalFilePath } from "./work-products/producer-seal.js";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepOutputBindings } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { isPgUniqueViolation } from "./pg-error.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;
type WorkProductOpenTarget = { kind: "path" | "url"; value: string };
type WorkProductBrowserOpenTarget = { kind: "url"; value: string };

function toIssueWorkProduct(row: IssueWorkProductRow): IssueWorkProduct {
  return {
    id: row.id,
    companyId: row.companyId,
    projectId: row.projectId ?? null,
    issueId: row.issueId,
    executionWorkspaceId: row.executionWorkspaceId ?? null,
    runtimeServiceId: row.runtimeServiceId ?? null,
    type: row.type as IssueWorkProduct["type"],
    provider: row.provider,
    externalId: row.externalId ?? null,
    title: row.title,
    url: row.url ?? null,
    status: row.status,
    reviewState: row.reviewState as IssueWorkProduct["reviewState"],
    isPrimary: row.isPrimary,
    healthStatus: row.healthStatus as IssueWorkProduct["healthStatus"],
    summary: row.summary ?? null,
    metadata: (row.metadata as Record<string, unknown> | null) ?? null,
    createdByRunId: row.createdByRunId ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" || url.protocol === "file:";
  } catch {
    return false;
  }
}

function isBrowserOpenableUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

export function resolveWorkProductOpenTarget(product: Pick<IssueWorkProduct, "metadata" | "provider" | "url">): WorkProductOpenTarget | null {
  const localPath = resolveWorkProductLocalFilePath(product);
  if (localPath) return { kind: "path", value: localPath };

  const url = product.url?.trim();
  if (url && isOpenableUrl(url)) return { kind: "url", value: url };

  return null;
}

export function resolveWorkProductBrowserOpenTarget(
  product: Pick<IssueWorkProduct, "id" | "metadata" | "url">,
): WorkProductBrowserOpenTarget | null {
  const url = product.url?.trim();
  if (url && isBrowserOpenableUrl(url)) return { kind: "url", value: url };

  if (resolveWorkProductLocalFilePath(product)) {
    return { kind: "url", value: `/api/work-products/${encodeURIComponent(product.id)}/content` };
  }

  return null;
}

export function workProductService(db: Db) {
  const producerWrite = workProductProducerWrite(db);
  return {
    listForIssue: async (issueId: string) => {
      const rows = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.issueId, issueId))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.updatedAt));
      return rows.map(toIssueWorkProduct);
    },

    getById: async (id: string) => {
      const row = await db
        .select()
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWorkProduct(row) : null;
    },

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">, delegation?: Parameters<typeof registeredProducer>[4]) => {
      const row = await producerWrite.createForIssue(issueId, companyId, data, delegation);
      return row ? toIssueWorkProduct(row) : null;
    },

    restampProducer: async (id: string, runId: string, stamp: Record<string, unknown>, delegation?: Parameters<typeof registeredProducer>[4]) => {
      const row = await producerWrite.restampProducer(id, runId, stamp, delegation);
      return row ? toIssueWorkProduct(row) : null;
    },

    update: async (id: string, patch: Partial<typeof issueWorkProducts.$inferInsert>) => {
      // [봇 bug·medium 교정] "경로 결정" 을 필드 명목이 아니라 실제 해석 경로 변화로 판정한다
      //   (storageMirror 의 metadata 병합은 경로 불변 시 통과, provider/url 및 경로 변화는 가드).
      //   가드는 UPDATE 문장 자체의 NOT EXISTS — 핀 INSERT(FK)와의 경합창이 없는 원자 차단.
      const row = await db.transaction(async (tx) => {
        const existing = await tx
          .select()
          .from(issueWorkProducts)
          .where(eq(issueWorkProducts.id, id))
          .then((rows) => rows[0] ?? null);
        if (!existing) return null;
        patch = { ...patch, sourceExecutionGeneration: existing.sourceExecutionGeneration, createdByRunId: existing.createdByRunId,
          ...(patch.metadata !== undefined ? { metadata: preserveProducerMetadata(patch.metadata, existing.metadata?.workflowProducer, existing.metadata) } : {}) };
        const pathBefore = resolveWorkProductLocalFilePath(existing) ?? "";
        const merged = { ...existing, ...patch } as typeof existing;
        const pathAfter = resolveWorkProductLocalFilePath(merged) ?? "";
        const pathAffecting = pathBefore !== pathAfter
          || ("provider" in patch && patch.provider !== existing.provider)
          || ("url" in patch && patch.url !== existing.url);


        if (patch.isPrimary === true) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, existing.companyId),
                eq(issueWorkProducts.issueId, existing.issueId),
                eq(issueWorkProducts.type, existing.type),
              ),
            );
        }

        let updated: typeof existing | null = null;
        try {
          updated = await tx
            .update(issueWorkProducts)
            .set({ ...patch, updatedAt: new Date() })
            .where(and(
              eq(issueWorkProducts.id, id),
              ...(pathAffecting
                ? [notExists(
                  db
                    .select({ one: workflowStepOutputBindings.id })
                    .from(workflowStepOutputBindings)
                    .where(eq(workflowStepOutputBindings.workProductId, id)),
                )]
                : []),
            ))
            .returning()
            .then((rows) => rows[0] ?? null);
        } catch (error) {
          // [봇 bug·medium 교정] 동시 승격(patch.isPrimary=true) 충돌은 이제 23505 하드 실패다
          //   (종전 조용한 이중 대표 드리프트). savepoint 없이는 tx 자체가 abort 되므로 이 catch
          //   는 재시도가 아니라 분류만 한다 — 409 로 재시도 가능하게 보고한다.
          if (isPgUniqueViolation(error)) {
            throw conflict("workproduct_primary_promotion_conflict", { workProductId: id });
          }
          throw error;
        }
        // [봇 bug·medium 교정 — 0행 재분류] 0행 원인이 핀은 아닐 수 있다(동시 삭제). 증거
        //   조회로 실제 원인을 판정한다: 핀 → 409, 무증거(행 소실) → null(기존 계약).
        if (!updated && pathAffecting) {
          const [bound] = await tx
            .select({ id: workflowStepOutputBindings.id })
            .from(workflowStepOutputBindings)
            .where(eq(workflowStepOutputBindings.workProductId, id))
            .limit(1);
          if (bound) {
            throw conflict("workproduct_in_use", { workProductId: id, reason: "path_affecting_patch_on_pinned_product" });
          }
          // [봇 bug·medium 교정 — 이중 경합 분류] 핀이 경합창에서 사라졌을 수 있다 — 행
          //   실재 여부로 재판정: 살아있으면 불확정 경합(재시도 가능 409), 없으면 null.
          const [alive] = await tx
            .select({ id: issueWorkProducts.id })
            .from(issueWorkProducts)
            .where(eq(issueWorkProducts.id, id))
            .limit(1);
          if (alive) {
            throw conflict("workproduct_update_race", { workProductId: id });
          }
          return null;
        }
        return updated;
      });
      return row ? toIssueWorkProduct(row) : null;
    },

    remove: async (id: string) => {
      // [스테이지 A + 봇 교정] 핀 존재 확인-후-삭제는 경합으로 FK 500 이 샐 수 있다 —
      //   삭제 문장 자체에 NOT EXISTS 가드를 걸어 원자적으로 판정한다. 의미론은
      //   delete-wins 스냅숏 평가: 가드 통과 후 늦게 커밋된 핀은 산출물 cascade 로 함께
      //   사라지고, 삭제보다 먼저 커밋된 핀은 0행 → 409 로 분류된다(핀 삽입 측 23503 은
      //   등록 실패 경로로 분류됨 — 등록 계약상 드문 경합).
      const deleted = await db
        .delete(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.id, id),
          notExists(
            db
              .select({ one: workflowStepOutputBindings.id })
              .from(workflowStepOutputBindings)
              .where(eq(workflowStepOutputBindings.workProductId, id)),
          ),
        ))
        .returning()
        .then((rows) => rows[0] ?? null);
      if (deleted) return toIssueWorkProduct(deleted);
      // 0행 — 소비 증거가 있으면 409, 대상 자체가 없으면 null(기존 계약).
      const [stillThere] = await db
        .select({ id: issueWorkProducts.id })
        .from(issueWorkProducts)
        .where(eq(issueWorkProducts.id, id))
        .limit(1);
      if (stillThere) {
        throw conflict("workproduct_in_use", { workProductId: id });
      }
      return null;
    },
  };
}

export { toIssueWorkProduct };
