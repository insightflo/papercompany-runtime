import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import {
  executionWorkspaces,
  issues,
  projects,
  workspaceOperations,
  workspaceRuntimeServices,
  type Db,
} from "@paperclipai/db";
import { expect } from "vitest";
import type { ResumeExecutionHistoryScope } from "../../services/workflow/resume/read-model.js";
import { readResumeMissionWorkspaceHistory } from "../../services/workflow/resume/read-model-workspaces.js";
import {
  canonicalMissionDomain,
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  seedForeignReadModelGraph,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedResourceMissionRuntime,
} from "./workflow-resume-mission-fixture.js";
import { expectReason, seedLinkedWakeup, seedSelectedGraph } from "./workflow-resume-links-fixture.js";

/**
 * [목적] Task5c3e workspace-linked discovery 테스트 픽스처. 승인된 mission/links fixture 를
 *   import 로만 재사용(수정 금지)하고, 이 슬라이스 전용 조립만 추가한다: 공개 wrapper 의 실제
 *   repeatable-read read-only 호출, mission canonical 에 execution_workspaces 전체 행(id
 *   오름차순)을 확장한 canonical 스냅샷, project+workspace 시더, null-heartbeat 정리 연산을
 *   포함한 workspace 연산 시더, executionWorkspaceId 를 갖는 runtime service 시더, 격리 fixture
 *   안에서 pg_constraint 로 발견한 issues FK 의 임시 drop/원복(반드시 finally) 헬퍼.
 *   실제 임베디드 PostgreSQL — mock DB/loader/해시/skip 없음.
 */

export {
  canonicalMissionDomain,
  captureHttpError,
  cleanupResourceTables,
  readModelScope,
  seedForeignReadModelGraph,
  seedLinkedWakeup,
  seedReadModelHeartbeat,
  seedReadModelIssue,
  seedResourceMissionRuntime,
  seedSelectedGraph,
  expectReason,
};
export type { ExecutionDefinitionFixture, RawSql, ReadModelGraph } from "./workflow-resume-mission-fixture.js";

/** [reader 전후 전체 도메인 증거] mission canonical 스냅샷 + execution_workspaces 전체 행. */
export async function canonicalWorkspaceDomain(db: Db) {
  const base = await canonicalMissionDomain(db);
  const workspaces = await db.select().from(executionWorkspaces).orderBy(executionWorkspaces.id);
  return { ...base, executionWorkspaces: workspaces };
}

export type WorkspaceDomainSnapshot = Awaited<ReturnType<typeof canonicalWorkspaceDomain>>;

/** [계약] 공개 wrapper 호출은 성공/오류 전부 실제 repeatable-read read-only 트랜잭션에서 실행. */
export function readMissionWorkspacesReadonly(db: Db, scope: ResumeExecutionHistoryScope) {
  return db.transaction((tx) => readResumeMissionWorkspaceHistory(tx, scope), {
    isolationLevel: "repeatable read",
    accessMode: "read only",
  });
}

/**
 * certified 공개 호출 전후 canonical 무변화 — 재사용된 before 를 신뢰하지 않는다. 매 호출 run 직전
 * fresh immediate baseline 을 다시 캡처해 before 와 대조하고(호출 사이 시딩/변이로 낡은 baseline 이면
 * 즉시 실패), finally 에서는 canonical 을 immediate baseline 과 비교해 오류 시에도 비교를 보장한다.
 */
export async function expectDomainUnchanged<T>(
  db: Db,
  before: WorkspaceDomainSnapshot,
  run: () => Promise<T>,
): Promise<T> {
  const immediateBefore = await canonicalWorkspaceDomain(db);
  expect(immediateBefore).toEqual(before);
  try {
    return await run();
  } finally {
    expect(await canonicalWorkspaceDomain(db)).toEqual(immediateBefore);
  }
}

/** workspace fixture 정리 — FK 역순: 연산/서비스 → workspace → 기존 resource/이력 → projects. */
export async function cleanupWorkspaceTables(db: Db): Promise<void> {
  await db.delete(workspaceOperations);
  await db.delete(workspaceRuntimeServices);
  await db.delete(executionWorkspaces);
  await cleanupResourceTables(db);
  await db.delete(projects);
}

/** project + execution workspace 시딩 — issues/services/operations 의 명시적 FK seed 대상. */
export async function seedExecutionWorkspace(
  db: Db,
  input: {
    companyId: string;
    name?: string;
    sourceIssueId?: string;
    derivedFromExecutionWorkspaceId?: string;
  },
): Promise<string> {
  const [project] = await db.insert(projects).values({
    companyId: input.companyId,
    name: "workspace-fixture-" + randomUUID().slice(0, 8),
  }).returning();
  const [workspace] = await db.insert(executionWorkspaces).values({
    companyId: input.companyId,
    projectId: project!.id,
    mode: "worktree",
    strategyType: "local_path",
    name: input.name ?? "workspace-fixture",
    ...(input.sourceIssueId ? { sourceIssueId: input.sourceIssueId } : {}),
    ...(input.derivedFromExecutionWorkspaceId
      ? { derivedFromExecutionWorkspaceId: input.derivedFromExecutionWorkspaceId }
      : {}),
  }).returning();
  return workspace!.id;
}

/** issues.executionWorkspaceId 연결 — accepted issue 시더에 이 필드가 없어 분리한 연결 시더. */
export async function linkIssueExecutionWorkspace(
  db: Db,
  issueId: string,
  executionWorkspaceId: string,
): Promise<void> {
  await db.update(issues).set({ executionWorkspaceId }).where(eq(issues.id, issueId));
}

/** executionWorkspaceId 를 갖는 runtime service — accepted service 시더에 없는 필드의 직접 insert. */
export async function seedWorkspaceRuntimeServiceRow(
  db: Db,
  input: {
    companyId: string;
    executionWorkspaceId: string;
    issueId?: string;
    startedByRunId?: string;
    scopeType: string;
    scopeId?: string;
    serviceName?: string;
    status?: string;
  },
): Promise<string> {
  const [row] = await db.insert(workspaceRuntimeServices).values({
    id: randomUUID(),
    companyId: input.companyId,
    executionWorkspaceId: input.executionWorkspaceId,
    ...(input.issueId ? { issueId: input.issueId } : {}),
    ...(input.startedByRunId ? { startedByRunId: input.startedByRunId } : {}),
    scopeType: input.scopeType,
    ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    serviceName: input.serviceName ?? "workspace-service",
    status: input.status ?? "running",
    lifecycle: "ephemeral",
    provider: "docker",
  }).returning();
  return row!.id;
}

/** null-heartbeat 정리 연산을 포함한 workspace 연산 시더 — executionWorkspaceId/metadata 지원. */
export async function seedWorkspaceScopedOperation(
  db: Db,
  input: {
    companyId: string;
    executionWorkspaceId: string | null;
    heartbeatRunId?: string;
    phase?: string;
    command?: string;
    status?: string;
    exitCode?: number | null;
    metadata?: Record<string, unknown>;
    startedAt?: Date;
    finishedAt?: Date;
  },
): Promise<string> {
  const [row] = await db.insert(workspaceOperations).values({
    companyId: input.companyId,
    ...(input.executionWorkspaceId ? { executionWorkspaceId: input.executionWorkspaceId } : {}),
    ...(input.heartbeatRunId ? { heartbeatRunId: input.heartbeatRunId } : {}),
    phase: input.phase ?? "cleanup",
    ...(input.command !== undefined ? { command: input.command } : {}),
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
    ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
    ...(input.startedAt !== undefined ? { startedAt: input.startedAt } : {}),
    ...(input.finishedAt !== undefined ? { finishedAt: input.finishedAt } : {}),
  }).returning();
  return row!.id;
}

export interface IssueWorkspaceForeignKey {
  name: string;
  definition: string;
}

/**
 * pg_constraint 에서 issues → execution_workspaces FK 를 발견한다. FK 가 정확히 하나인지 검증하고,
 * pg_attribute 로 conkey 가 execution_workspace_id 컬럼임을 확인한 뒤, 원래 정의
 * (pg_get_constraintdef 결과)를 재구성하지 않고 그대로 캡처한다 — 복원은 캡처 복원이다.
 */
export async function findIssueExecutionWorkspaceFk(sql: RawSql): Promise<IssueWorkspaceForeignKey> {
  const rows = await sql`
    SELECT conname AS name, pg_get_constraintdef(oid) AS definition FROM pg_constraint
    WHERE conrelid = 'issues'::regclass
      AND confrelid = 'execution_workspaces'::regclass
      AND contype = 'f'
  `;
  if (rows.length !== 1) {
    throw new Error(`expected exactly one issues → execution_workspaces FK in pg_constraint, found ${rows.length}`);
  }
  const row = rows[0] as { name: string; definition: string };
  const columns = await sql`
    SELECT attr.attname FROM pg_constraint con
    JOIN unnest(con.conkey) AS k(attnum) ON true
    JOIN pg_attribute attr ON attr.attrelid = con.conrelid AND attr.attnum = k.attnum
    WHERE con.conname = ${row.name} AND con.conrelid = 'issues'::regclass AND con.contype = 'f'
  `;
  const names = columns.map((column) => (column as { attname: string }).attname);
  if (names.length !== 1 || names[0] !== "execution_workspace_id") {
    throw new Error(`issues → execution_workspaces FK is not exactly on execution_workspace_id: ${names.join(", ")}`);
  }
  return { name: row.name, definition: row.definition };
}

/** [격리 fixture 전용] 임시 FK drop — 테스트 finally 에서 반드시 restore 를 함께 호출할 것. */
export async function dropIssueExecutionWorkspaceFk(sql: RawSql, fk: IssueWorkspaceForeignKey): Promise<void> {
  await sql.unsafe(`ALTER TABLE issues DROP CONSTRAINT "${fk.name.replace(/"/g, '""')}"`);
}

/** 캡처한 원래 정의(pg_get_constraintdef)를 그대로 복원한다 — 데이터 원복 이후 호출할 것. */
export async function restoreIssueExecutionWorkspaceFk(sql: RawSql, fk: IssueWorkspaceForeignKey): Promise<void> {
  await sql.unsafe(
    `ALTER TABLE issues ADD CONSTRAINT "${fk.name.replace(/"/g, '""')}" ${fk.definition}`,
  );
}
