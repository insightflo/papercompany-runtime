import { and, eq, ne } from "drizzle-orm";
import { existsSync } from "node:fs";
import path from "node:path";
import { issueWorkProducts, type Db } from "@paperclipai/db";
import { conflict } from "../../errors.js";
import { isPgUniqueViolation } from "../pg-error.js";
import { assertIssueResumeScopeIdentity } from "../workflow/resume-scope-fence.js";
import { registeredProducer } from "./producer-provenance.js";
import { matchWorkProductContractPromotion, recordContractPromotionAudit, type ContractPromotionMatch } from "./contract-promotion.js";
import { metadataPath, sealedProducerMetadata } from "./producer-seal.js";

type IssueWorkProductRow = typeof issueWorkProducts.$inferSelect;

function isLocalFileProvider(provider: string) {
  return provider === "local" || provider === "local_file";
}

function hasValidLocalFilePath(data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">) {
  if (!isLocalFileProvider(data.provider)) return true;
  if (data.type !== "artifact" && data.type !== "document") return true;

  const localPath = metadataPath(data.metadata);
  if (!localPath || !path.isAbsolute(localPath)) return false;
  return existsSync(localPath);
}

/** Own producer validation, byte sealing and transactional writes; the public service maps returned rows. */
export function workProductProducerWrite(db: Db) {
  return {
    createForIssue: async (issueId: string, companyId: string, data: Omit<typeof issueWorkProducts.$inferInsert, "issueId" | "companyId">, delegation?: Parameters<typeof registeredProducer>[4]) => {
      if (!hasValidLocalFilePath(data)) return null;
      // [Task6c-D] resume-linked issue 의 agent artifact 등록은 세대 정체 검증만 수행한다
      //   (새 approval 절차 추가 아님). issue 의 active step run 이 resume run 부모의 현재
      //   stamp 과 어긋나면 그 등록은 이전 세대 결과 — 409 stale_generation 으로 거절한다.
      //   ordinary issue 는 검증이 즉시 true — 기존 동작 byte-identical.
      if (!(await assertIssueResumeScopeIdentity(db, { companyId, issueId }))) {
        throw conflict("stale_generation", { issueId });
      }
      const row = await db.transaction(async (tx) => {
        const producer = await registeredProducer(tx, companyId, issueId, data.createdByRunId, delegation);
        data = { ...data, sourceExecutionGeneration: producer?.executionGeneration ?? null,
          metadata: await sealedProducerMetadata(data, producer) };
        let isPrimary: boolean | undefined = data.isPrimary;
        let contractMatch: ContractPromotionMatch | null = null;
        if (isPrimary === undefined) {
          // [산출물 소비 하드닝 2a] 미지정 해석 우선순위: ① 계약 부합 승격 > ② 빈 이슈 첫 등록만 > false.
          //   위임(delegation) 등록은 원본 미러 의미 보존을 위해 ① 대상이 아니다(생산자 run/step 신원도 없다).
          if (!delegation && producer?.schemaVersion === "workflow.work-product-producer.v1") {
            contractMatch = await matchWorkProductContractPromotion(tx, {
              workflowRunId: producer.workflowRunId, producerStepId: producer.stepId,
              type: data.type, title: data.title,
            });
          }
          if (contractMatch) {
            isPrimary = true;
          } else {
            // ② 이슈에 타입 무관 비archived 산출물이 없을 때만 첫 등록이 대표다
            //   (구 규칙 "타입별 첫 등록" 폐지 — 혼합 타입 이슈의 두 번째 타입 첫 산출물은 대표 아님).
            const [existingAnyProduct] = await tx
              .select({ id: issueWorkProducts.id })
              .from(issueWorkProducts)
              .where(
                and(
                  eq(issueWorkProducts.companyId, companyId),
                  eq(issueWorkProducts.issueId, issueId),
                  ne(issueWorkProducts.status, "archived"),
                ),
              )
              .limit(1);
            isPrimary = !existingAnyProduct;
          }
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
        let inserted: IssueWorkProductRow | null = null;
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
            inserted = await insertPrimary();
          } catch (error) {
            // [봇 bug·high 교정] drizzle 은 원본 PG 오류를 cause 체인에 둔다 — 공용 판별 사용.
            if (!isPgUniqueViolation(error)) throw error;
            inserted = await tx
              .insert(issueWorkProducts)
              .values({ ...data, isPrimary: false, companyId, issueId })
              .returning()
              .then((rows) => rows[0] ?? null);
          }
        } else {
          inserted = await tx
            .insert(issueWorkProducts)
            .values({
              ...data,
              isPrimary,
              companyId,
              issueId,
            })
            .returning()
            .then((rows) => rows[0] ?? null);
        }
        // ① 계약 부합 승격만 감사 — 23505 폴백으로 비대표로 확정된 경우는 승격이 아니므로 제외.
        if (inserted && contractMatch && inserted.isPrimary) {
          await recordContractPromotionAudit(tx as Pick<Db, "insert">, {
            companyId, workProductId: inserted.id, match: contractMatch,
          });
        }
        return inserted;
      });
      return row;
    },

    // [same-path rework restamp] Re-registering an existing artifact path from a heartbeat must prove the
    //   CURRENT attempt with the same fail-closed checks as createForIssue, then move producer provenance
    //   to that heartbeat. Other metadata is preserved; only the registration stamp keys are replaced.
    restampProducer: async (id: string, runId: string, stamp: Record<string, unknown>, delegation?: Parameters<typeof registeredProducer>[4]) => {
      const [current] = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, id));
      if (!current) return null;
      if (!(await assertIssueResumeScopeIdentity(db, { companyId: current.companyId, issueId: current.issueId }))) {
        throw conflict("stale_generation", { issueId: current.issueId });
      }
      const row = await db.transaction(async (tx) => {
        // Same lock order as selection (run/step first via registeredProducer, then the product row) to avoid deadlock.
        const producer = await registeredProducer(tx, current.companyId, current.issueId, runId, delegation);
        const [existing] = await tx.select().from(issueWorkProducts).where(eq(issueWorkProducts.id, id)).for("update");
        if (!existing || existing.issueId !== current.issueId || existing.companyId !== current.companyId) return null;
        return await tx.update(issueWorkProducts).set({ createdByRunId: runId,
          sourceExecutionGeneration: producer?.executionGeneration ?? null,
          metadata: await sealedProducerMetadata({ ...existing, metadata: { ...(existing.metadata ?? {}), ...stamp } }, producer), updatedAt: new Date() })
          .where(eq(issueWorkProducts.id, id)).returning().then((rows) => rows[0] ?? null);
      });
      return row;
    },

  };
}
