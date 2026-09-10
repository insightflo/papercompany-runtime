import { randomUUID } from "node:crypto";
import { activityLog, type Db } from "@paperclipai/db";
import type { RawSql } from "./workflow-execution-definition-fixture.js";
import { hashStructuredValue } from "../../services/issue-execution-cards/hash.js";
import type { ReviewedHistoricalProvenance } from "../../services/workflow/execution-definition-codec.js";
import { REVIEWED_HISTORICAL_DEFINITION_FACTS } from "../../services/workflow/resume/historical-import-core.js";

/**
 * [파일 목적] reviewed historical import 테스트 픽스처(순수 + 시딩 헬퍼).
 *   recovered steps 무결성 회복물(unknown 필드/한글 포함), audited 사실과 일치하는 provenance
 *   조립, legacy terminal run 시딩, 쓰기 카운터, audit-insert 실패 주입 Db 프록시를 제공한다.
 *   production audited UUID 는 절대 사용하지 않는다(테스트는 임의 스코프에서 관계 일관성만 검증).
 */

/** delivery 키워드가 없어 정규화가 step 을 추가/변형하지 않는 최소 recovered 3step. */
export function recoveredStepsFixture(): Array<Record<string, unknown>> {
  return [
    {
      id: "recover-select",
      name: "소재 선택",
      type: "agent",
      agentId: "",
      agentName: "Research Agent",
      dependsOn: [],
      description: "후보 3개를 카드로 제시하고 운영자가 1개를 선택한다.",
      toolNames: ["storage", "topic-card"],
    },
    {
      id: "recover-script",
      name: "스크립트 작성",
      type: "agent",
      agentId: "agent-script",
      dependencies: ["recover-select"],
      toolArgs: { minutes: 3, options: { tone: "경제" } },
    },
    {
      id: "recover-factcheck",
      name: "팩트체크",
      type: "qa",
      agentId: "agent-factcheck",
      dependsOn: "recover-script",
      qaType: "fact_check",
    },
  ];
}

export function sourceStepsHashOf(steps: unknown[]): string {
  return hashStructuredValue(steps);
}

export function historicalProvenanceFixture(input: {
  workflowId: string;
  missionId: string;
  sourceStepsHash: string;
  reviewedBy?: string;
  reviewedAt?: string;
}): ReviewedHistoricalProvenance {
  return {
    schemaVersion: 1,
    origin: "reviewed_historical_import",
    workflowId: input.workflowId,
    missionId: input.missionId,
    workflowName: REVIEWED_HISTORICAL_DEFINITION_FACTS.workflowName,
    source: REVIEWED_HISTORICAL_DEFINITION_FACTS.source,
    sourceKind: REVIEWED_HISTORICAL_DEFINITION_FACTS.sourceKind,
    definitionUpdatedAt: REVIEWED_HISTORICAL_DEFINITION_FACTS.definitionUpdatedAt,
    review: {
      schemaVersion: 1,
      sourceStepsHash: input.sourceStepsHash,
      sourceRecord: "session:test-session.jsonl tool-lines:1-2 run-lines:3-4",
      reviewedBy: input.reviewedBy ?? "operator-a",
      reviewedAt: input.reviewedAt ?? "2026-09-10T09:00:00.000Z",
    },
  };
}

export type LegacyRunSeed = {
  runId: string;
  stepIds: string[];
};

/** 실제 legacy terminal run — status/기록 시각을 포함해 run step 행을 stepId 순으로 시딩한다. */
export async function seedLegacyTerminalRun(
  sql: RawSql,
  input: {
    workflowId: string;
    companyId: string;
    missionId: string;
    stepIds: string[];
    status?: string;
    metadata?: Record<string, unknown>;
  },
): Promise<LegacyRunSeed> {
  const runId = randomUUID();
  await sql`
    INSERT INTO workflow_runs (id, workflow_id, company_id, mission_id, status, triggered_by, metadata, started_at, completed_at)
    VALUES (
      ${runId}, ${input.workflowId}, ${input.companyId}, ${input.missionId},
      ${input.status ?? "completed"}, 'historical-import-test',
      ${JSON.stringify(input.metadata ?? {})}, '2026-08-15T07:00:00Z', '2026-08-15T07:30:00Z'
    )
  `;
  for (const stepId of input.stepIds) {
    await sql`
      INSERT INTO workflow_step_runs (id, workflow_run_id, step_id, status, agent_name)
      VALUES (${randomUUID()}, ${runId}, ${stepId}, 'completed', 'legacy-agent')
    `;
  }
  return { runId, stepIds: input.stepIds };
}

export async function countDefinitionRows(sql: RawSql, runId: string): Promise<number> {
  const rows = await sql`SELECT count(*)::int AS count FROM workflow_run_definitions WHERE workflow_run_id = ${runId}`;
  return rows[0]?.count ?? 0;
}

export async function countAuditRows(sql: RawSql, runId: string): Promise<number> {
  const rows = await sql`
    SELECT count(*)::int AS count FROM activity_log
    WHERE action = 'workflow.execution_definition_imported' AND entity_id = ${runId}
  `;
  return rows[0]?.count ?? 0;
}

/** activity_log insert 에서만 실패를 주입하는 Db 프록시 — 감사 실패 시 전체 롤백을 검증한다. */
export function auditFailingDb(db: Db): Db {
  return {
    transaction: (callback: Parameters<Db["transaction"]>[0]) =>
      db.transaction(async (tx) => {
        const guarded = Object.create(tx) as typeof tx;
        guarded.insert = ((table: Parameters<typeof tx.insert>[0]) => {
          if (table === activityLog) {
            throw new Error("injected_audit_failure");
          }
          return tx.insert(table);
        }) as unknown as typeof tx.insert;
        return await callback(guarded);
      }),
  } as unknown as Db;
}
