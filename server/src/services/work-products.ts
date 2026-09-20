import { and, desc, eq, notExists } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Db } from "@paperclipai/db";
import { issueWorkProducts, workflowStepOutputBindings } from "@paperclipai/db";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { conflict } from "../errors.js";
import { isPgUniqueViolation } from "./pg-error.js";
import { assertIssueResumeScopeIdentity } from "./workflow/resume-scope-fence.js";

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

function isLocalFileProvider(provider: string) {
  return provider === "local" || provider === "local_file";
}

function metadataPath(metadata: unknown): string | null {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return null;
  const value = (metadata as Record<string, unknown>).path;
  return typeof value === "string" && value.trim() ? value.trim() : null;
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

export function resolveWorkProductLocalFilePath(product: Pick<IssueWorkProduct, "metadata" | "url">): string | null {
  const localPath = metadataPath(product.metadata);
  if (localPath && path.isAbsolute(localPath)) return localPath;

  const url = product.url?.trim();
  if (!url) return null;

  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "file:") return null;
    return fileURLToPath(parsed);
  } catch {
    return null;
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

function hasValidLocalFilePath(data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) {
  if (!isLocalFileProvider(data.provider)) return true;
  if (data.type !== "artifact" && data.type !== "document") return true;

  const localPath = metadataPath(data.metadata);
  if (!localPath || !path.isAbsolute(localPath)) return false;
  return existsSync(localPath);
}

export function workProductService(db: Db) {
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

    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) => {
      if (!hasValidLocalFilePath(data)) return null;
      // [Task6c-D] resume-linked issue 의 agent artifact 등록은 세대 정체 검증만 수행한다
      //   (새 approval 절차 추가 아님). issue 의 active step run 이 resume run 부모의 현재
      //   stamp 과 어긋나면 그 등록은 이전 세대 결과 — 409 stale_generation 으로 거절한다.
      //   ordinary issue 는 검증이 즉시 true — 기존 동작 byte-identical.
      if (!(await assertIssueResumeScopeIdentity(db, { companyId, issueId }))) {
        throw conflict("stale_generation", { issueId });
      }
      const row = await db.transaction(async (tx) => {
        // [생략 등록 보호] isPrimary 미지정 등록은 기존 활성 대표를 강등하지 않는다.
        //   같은 스코프(company+issue+type — 종전 강등 단위와 동일 분류)에 활성 대표가
        //   있으면 비대표(false)로 등록하고, 없으면 종전대로 대표(true)로 등록한다
        //   (첫 산출물 생략 호출자 호환). 명시 true/false는 종전 관찰 계약 그대로며,
        //   생략 해석은 라우트 검증 계층의 default(true) 대신 이 서비스 계약이 담당한다.
        let isPrimary: boolean | undefined = data.isPrimary;
        if (isPrimary === undefined) {
          const [existingPrimary] = await tx
            .select({ id: issueWorkProducts.id })
            .from(issueWorkProducts)
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
                eq(issueWorkProducts.isPrimary, true),
              ),
            )
            .limit(1);
          isPrimary = !existingPrimary;
        }
        if (isPrimary) {
          await tx
            .update(issueWorkProducts)
            .set({ isPrimary: false, updatedAt: new Date() })
            .where(
              and(
                eq(issueWorkProducts.companyId, companyId),
                eq(issueWorkProducts.issueId, issueId),
                eq(issueWorkProducts.type, data.type),
              ),
            );
        }
        if (isPrimary) {
          // [봇 bug·high 교정] 트랜잭션 내 문장 실패 후 재시도는 25P02 로 반드시 실패한다 —
          //   첫 insert 를 savepoint(중첩 tx)로 감싸 23505 를 savepoint 밖으로 끊어낸 뒤,
          //   살아있는 외부 tx 에서 비대표로 재등록한다(등록 계약: 등록 자체는 늘 성공).
          //   (tx.transaction 없는 테스트 더블은 성공 경로만 시뮬레이션 — 직접 insert 로 폴백.)
          const insertPrimary = async (): Promise<typeof issueWorkProducts.$inferSelect | null> => {
            const values = { ...data, isPrimary, companyId, issueId };
            if (typeof tx.transaction === "function") {
              return await tx.transaction(async (nested) =>
                nested
                  .insert(issueWorkProducts)
                  .values(values)
                  .returning()
                  .then((rows) => rows[0] ?? null));
            }
            return await tx
              .insert(issueWorkProducts)
              .values(values)
              .returning()
              .then((rows) => rows[0] ?? null);
          };
          try {
            return await insertPrimary();
          } catch (error) {
            // [봇 bug·high 교정] drizzle 은 원본 PG 오류를 cause 체인에 둔다 — 공용 판별 사용.
            if (!isPgUniqueViolation(error)) throw error;
            return await tx
              .insert(issueWorkProducts)
              .values({ ...data, isPrimary: false, companyId, issueId })
              .returning()
              .then((rows) => rows[0] ?? null);
          }
        }
        return await tx
          .insert(issueWorkProducts)
          .values({
            ...data,
            isPrimary,
            companyId,
            issueId,
          })
          .returning()
          .then((rows) => rows[0] ?? null);
      });
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
