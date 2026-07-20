/**
 * [purpose] Embedded-Postgres fixture helpers for the IF condition source resolver
 *   test. Keeps the resolver test file under the 300-line limit by isolating DB/company
 *   setup, producer step_run + work-product construction, and temp-file tracking.
 */
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  companies,
  createDb,
  issueWorkProducts,
  issues,
  workflowDefinitions,
  workflowRuns,
  workflowStepRuns,
} from "@paperclipai/db";
import type { Db } from "@paperclipai/db";
import {
  startEmbeddedPostgresTestDatabase,
} from "./embedded-postgres.js";
import type { WorkflowConditionSource } from "@paperclipai/shared";

export interface ResolverFixture {
  db: Db;
  companyId: string;
  workflowId: string;
  cleanup(): Promise<void>;
}

export async function startResolverFixture(): Promise<ResolverFixture> {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-if-source-resolver-");
  const db = createDb(tempDb.connectionString);
  const companyId = randomUUID();
  const workflowId = randomUUID();
  await db.insert(companies).values({
    id: companyId,
    name: "IF Resolver Test",
    issuePrefix: `IR${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
  await db.insert(workflowDefinitions).values({
    id: workflowId,
    companyId,
    name: "if-resolver",
    stepsJson: [],
  });
  return {
    db,
    companyId,
    workflowId,
    cleanup: async () => {
      await tempDb.cleanup();
    },
  };
}

export async function createResolverRun(fixture: ResolverFixture): Promise<string> {
  const runId = randomUUID();
  await fixture.db.insert(workflowRuns).values({
    id: runId,
    workflowId: fixture.workflowId,
    companyId: fixture.companyId,
    triggeredBy: "test",
    status: "running",
  });
  return runId;
}

export interface ProducerStepOptions {
  runId: string;
  stepId: string;
  companyId?: string;
  status?: string;
  startedAt?: Date | null;
}

/** Creates an additional company row (for cross-company scoping tests). */
export async function createFixtureCompany(fixture: ResolverFixture, opts: { id: string; name: string }): Promise<void> {
  await fixture.db.insert(companies).values({
    id: opts.id,
    name: opts.name,
    issuePrefix: `OC${opts.id.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
    requireBoardApprovalForNewAgents: false,
  });
}

/** Creates a producer issue + a completed step_run and returns the issue id. */
export async function createProducerStep(fixture: ResolverFixture, opts: ProducerStepOptions): Promise<string> {
  const issueId = randomUUID();
  await fixture.db.insert(issues).values({
    id: issueId,
    companyId: opts.companyId ?? fixture.companyId,
    title: opts.stepId,
  });
  await fixture.db.insert(workflowStepRuns).values({
    workflowRunId: opts.runId,
    stepId: opts.stepId,
    issueId,
    status: opts.status ?? "completed",
    startedAt: opts.startedAt === undefined ? new Date() : opts.startedAt,
  });
  return issueId;
}

export interface WorkProductOptions {
  issueId: string;
  title: string;
  companyId?: string;
  content?: string | Buffer;
  filePath?: string | null;
  provider?: string;
  status?: string;
  isPrimary?: boolean;
  updatedAt?: Date;
}

export async function attachWorkProduct(
  fixture: ResolverFixture,
  registry: TempFileRegistry,
  opts: WorkProductOptions,
): Promise<string> {
  const filePath = opts.filePath ?? (opts.content !== undefined
    ? registry.tmp(opts.title, opts.content)
    : registry.tmp(opts.title, "{}"));
  await fixture.db.insert(issueWorkProducts).values({
    companyId: opts.companyId ?? fixture.companyId,
    issueId: opts.issueId,
    type: "artifact",
    provider: opts.provider ?? "local",
    title: opts.title,
    status: opts.status ?? "ready",
    isPrimary: opts.isPrimary ?? false,
    metadata: { path: filePath },
    updatedAt: opts.updatedAt,
  });
  return filePath;
}

export class TempFileRegistry {
  private readonly dirs: string[] = [];

  tmp(name: string, content: string | Buffer): string {
    const dir = mkdtempSync(path.join(os.tmpdir(), "if-resolver-wp-"));
    this.dirs.push(dir);
    const filePath = path.join(dir, name);
    writeFileSync(filePath, content);
    return filePath;
  }

  cleanup(): void {
    for (const dir of this.dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
}

export const RESOLVER_TOPOLOGY = [
  { id: "producer", name: "Producer", dependencies: [] },
  { id: "validator", name: "Validator", dependencies: ["producer"] },
  { id: "if-1", name: "If", dependencies: ["validator"] },
  { id: "unrelated", name: "Unrelated", dependencies: [] },
];

export function sourceOf(stepId: string, path = "$.status", title = "topic-decision.json"): WorkflowConditionSource {
  return { kind: "work_product_json", stepId, title, path };
}
