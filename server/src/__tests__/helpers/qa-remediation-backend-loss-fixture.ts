import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { and, eq } from "drizzle-orm";
import { expect } from "vitest";
import {
  agentWakeupRequests, agents, companies, createDb, heartbeatRuns, issueWorkProducts, issues,
  missions, startEmbeddedPostgresTestDatabase, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db, type EmbeddedPostgresTestDatabase,
} from "@paperclipai/db";
import { seedInternalAdmissionWorld } from "./qa-remediation-admission-public-fixture.js";
import { admittedProducer } from "./admitted-producer.js";
import { recordWorkflowValidationVerdict } from "../../services/workflow/validation-verdict-ledger.js";
import {
  QA_REMEDIATION_PREPARATION_EVENT_TYPE, parseQaRemediationPreparation,
} from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import {
  QA_REMEDIATION_COMPLETION_EVENT_TYPE, parseQaRemediationCompletion,
  qaRemediationCompletionKey, qaRemediationRefireV2WakeKey,
} from "../../services/workflow/control-flow/qa-remediation-completion.js";
import { WORKFLOW_ATTEMPT_PROOF_KEY } from "../../services/heartbeat-finalization/workflow-attempt-proof.js";

export const ROOT_BEFORE = "before source\n";
export const ROOT_AFTER = "after source\n";
export type TestDb = { readonly db: Db; readonly applicationName: string };
export type WakeRow = typeof agentWakeupRequests.$inferSelect;

export interface RootWorld {
  readonly companyId: string;
  readonly missionId: string;
  readonly runId: string;
  readonly producerStepRunId: string;
  readonly qaStepRunId: string;
  readonly verifier: string;
  readonly file: string;
  readonly dir: string;
  readonly verdictId: string;
  readonly heartbeatId: string;
  readonly seedWakes: readonly WakeRow[];
}

export interface BackendLossFixture {
  readonly postgres: EmbeddedPostgresTestDatabase;
  readonly lockRoot: string;
  readonly rootDb: TestDb;
  readonly observerDb: TestDb;
  readonly controllerDb: TestDb;
  readonly unrelatedDb: TestDb;
  makeDb(label: string): TestDb;
  closeDb(db: TestDb): Promise<void>;
  seedWorld(db: Db, label: string): Promise<RootWorld>;
  dispose(): Promise<void>;
}

export async function openBackendLossFixture(options: { realProducer?: boolean } = {}): Promise<BackendLossFixture> {
  const postgres = await startEmbeddedPostgresTestDatabase("qa-remediation-backend-loss-");
  const clients = new Set<Db>();
  const workspaces = new Set<string>();
  const fixtureClosers = new Set<() => Promise<void>>();
  let lockRootParent = "";

  const makeDb = (label: string): TestDb => {
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, "-").replace(/-+/g, "-").slice(0, 17) || "db";
    const applicationName = `c5-${safeLabel}-${randomUUID()}`;
    if (Buffer.byteLength(applicationName, "ascii") > 63) throw new Error("test application_name exceeds PostgreSQL's limit");
    const connection = new URL(postgres.connectionString);
    connection.searchParams.set("application_name", applicationName);
    const db = createDb(connection.toString());
    clients.add(db);
    return { db, applicationName };
  };

  const rootDb = makeDb("root");
  const observerDb = makeDb("observer");
  const controllerDb = makeDb("controller");
  const unrelatedDb = makeDb("unrelated");
  lockRootParent = await realpath(await mkdtemp(join(tmpdir(), "c5-backend-loss-locks-")));
  const lockRoot = join(lockRootParent, "guards");
  await mkdir(lockRoot, { mode: 0o700 });
  await realpath(lockRoot);

  const seedWorld = async (db: Db, label: string): Promise<RootWorld> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), `c5-backend-loss-${label}-`)));
    workspaces.add(dir);
    const file = join(dir, "report.md");
    await writeFile(file, ROOT_BEFORE, { mode: 0o600 });
    if (options.realProducer) {
      const seeded = await seedInternalAdmissionWorld(db, dir, lockRoot,
        { file, bytes: Buffer.from(ROOT_BEFORE), find: "before", replace: "after" });
      fixtureClosers.add(seeded.close);
      const u = seeded.unit;
      return { companyId: u.companyId, missionId: u.missionId, runId: u.runId,
        producerStepRunId: u.producer.id, qaStepRunId: u.qa.id, verifier: u.verifierId,
        file: u.file, dir, verdictId: u.verdictEventId, heartbeatId: u.verdictHeartbeatId,
        seedWakes: await wakeRows(db, u.companyId) };
    }
    const companyId = randomUUID(), author = randomUUID(), verifier = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Backend loss proof", issuePrefix: `BL${companyId.slice(0, 8)}` });
    await db.insert(agents).values([{ id: author, companyId, name: "Producer" }, { id: verifier, companyId, name: "Verifier" }]);
    const missionId = randomUUID(), workflowId = randomUUID(), runId = randomUUID();
    await db.insert(missions).values({ id: missionId, companyId, title: "Backend loss proof", ownerAgentId: author, status: "active" });
    await db.insert(workflowDefinitions).values({ id: workflowId, companyId, name: "Backend loss proof", stepsJson: [
      { id: "produce", name: "Produce", agentId: author, dependencies: [],
        conditionalDependencies: [{ stepId: "qa-check", when: "qa_request_changes", isBackEdge: true, maxIterations: 3 }] },
      { id: "qa-check", name: "QA", agentId: verifier, dependencies: ["produce"] },
    ] });
    await db.insert(workflowRuns).values({ id: runId, companyId, missionId, workflowId, status: "running", triggeredBy: "test", dispatchAuthorityVersion: 1 });
    const [producerIssue] = await db.insert(issues).values({ companyId, missionId, title: "Produce", status: "done", originKind: "workflow_execution" }).returning();
    const [qaIssue] = await db.insert(issues).values({ companyId, missionId, title: "[QA] Check", status: "todo", originKind: "workflow_execution" }).returning();
    const [producer] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "produce",
      issueId: producerIssue!.id, status: "completed", completedAt: new Date(Date.now() - 2000) }).returning();
    const [qa] = await db.insert(workflowStepRuns).values({ workflowRunId: runId, stepId: "qa-check", issueId: qaIssue!.id, status: "failed" }).returning();
    const producerHeartbeatId = randomUUID();
    await admittedProducer(db, { companyId, agentId: author, issueId: producerIssue!.id,
      stepRunId: producer!.id, heartbeatId: producerHeartbeatId });
    const verdictWakeId = randomUUID(), heartbeatId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: verdictWakeId, companyId, agentId: verifier, source: "workflow.dispatch", workflowStepRunId: qa!.id });
    await db.insert(heartbeatRuns).values({ id: heartbeatId, companyId, agentId: verifier, issueId: qaIssue!.id,
      wakeupRequestId: verdictWakeId, status: "succeeded", createdAt: new Date(Date.now() - 1000) });
    await recordWorkflowValidationVerdict({ db, issue: qaIssue!, source: "workflow_api", verdict: "request_changes",
      heartbeatRunId: heartbeatId, remediations: { items: [{ op: "string_replace", file, find: "before", replace: "after" }] } });
    const [verdict] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.heartbeatRunId, heartbeatId));
    if (!verdict || !producer || !qa) throw new Error("test workflow fixture did not persist its required identities");
    await db.insert(issueWorkProducts).values({ companyId, issueId: producerIssue!.id, type: "file",
      provider: "local_file", title: "report", status: "active", metadata: { path: file } });
    const seedWakes = await wakeRows(db, companyId);
    return { companyId, missionId, runId, producerStepRunId: producer.id, qaStepRunId: qa.id,
      verifier, file, dir, verdictId: verdict.id, heartbeatId, seedWakes };
  };

  const closeDb = async (testDb: TestDb) => {
    if (!clients.delete(testDb.db)) return;
    await testDb.db.$client.end({ timeout: 5 });
  };

  const dispose = async () => {
    await Promise.all([...fixtureClosers].map(close => close()));
    const results = await Promise.allSettled([...clients].map((db) => db.$client.end({ timeout: 5 })));
    clients.clear();
    const failures = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    for (const dir of workspaces) await rm(dir, { recursive: true, force: true });
    workspaces.clear();
    if (lockRootParent) await rm(lockRootParent, { recursive: true, force: true });
    await postgres.cleanup();
    if (failures.length) throw new AggregateError(failures, "test DB sessions did not close");
  };
  return { postgres, lockRoot, rootDb, observerDb, controllerDb, unrelatedDb, makeDb, closeDb, seedWorld, dispose };
}

export async function wakeRows(db: Db, companyId: string): Promise<WakeRow[]> {
  const rows = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
  return rows.sort((left, right) => left.id.localeCompare(right.id));
}

export async function eventRows(db: Db, world: RootWorld, eventType: string) {
  return db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, world.companyId),
    eq(workflowTransitionEvents.workflowRunId, world.runId),
    eq(workflowTransitionEvents.eventType, eventType),
  ));
}

export async function assertCommittedCompletion(db: Db, world: RootWorld) {
  const preparations = await eventRows(db, world, QA_REMEDIATION_PREPARATION_EVENT_TYPE);
  expect(preparations).toHaveLength(1);
  const preparationEvent = preparations[0]!;
  const preparation = parseQaRemediationPreparation(preparationEvent.payload);
  expect(preparationEvent.id).toBe(preparation.preparationId);
  const completions = await eventRows(db, world, QA_REMEDIATION_COMPLETION_EVENT_TYPE);
  expect(completions).toHaveLength(1);
  const completionEvent = completions[0]!;
  const completion = parseQaRemediationCompletion(completionEvent.payload);
  expect(completionEvent.id).toBe(completion.completionId);
  expect(completionEvent.idempotencyKey).toBe(qaRemediationCompletionKey(preparation));
  expect(completionEvent).toMatchObject({ companyId: world.companyId, missionId: world.missionId,
    workflowRunId: world.runId, workflowStepRunId: world.producerStepRunId,
    eventType: QA_REMEDIATION_COMPLETION_EVENT_TYPE });
  const verdict = preparation.verdicts[0]!;
  expect(verdict.eventId).toBe(world.verdictId);
  expect(verdict.heartbeatRunId).toBe(world.heartbeatId);
  const idempotencyKey = qaRemediationRefireV2WakeKey(preparation, verdict.qa.stepRunId, verdict.eventId);
  const allWakes = await wakeRows(db, world.companyId);
  const matching = allWakes.filter((wake) => wake.idempotencyKey === idempotencyKey);
  expect(matching).toHaveLength(1);
  const wake = matching[0]!;
  const receipt = { kind: "v2_refire" as const, wakeupRequestId: wake.id, idempotencyKey,
    agentId: world.verifier, issueId: verdict.qa.issueId, stepRunId: verdict.qa.stepRunId,
    stepId: verdict.qa.stepId, executionGeneration: verdict.qa.executionGeneration,
    sourceVerdictEventId: verdict.eventId, statusAtCommit: "queued" };
  expect(completion.wakes).toEqual([receipt]);
  expect(wake).toMatchObject({ companyId: world.companyId, agentId: world.verifier, source: "assignment",
    requestKind: "workflow_resume", issueId: verdict.qa.issueId, missionId: world.missionId,
    workflowRunId: world.runId, workflowStepRunId: verdict.qa.stepRunId,
    workflowExecutionGeneration: verdict.qa.executionGeneration, status: "queued", idempotencyKey });
  expect(wake.payload?.qaRemediationCompletion).toEqual({ preparationEventId: preparation.preparationId,
    sourceVerdictEventId: verdict.eventId });
  expect(wake.payload?.[WORKFLOW_ATTEMPT_PROOF_KEY]).toMatchObject({ schemaVersion: 1,
    companyId: world.companyId, agentId: world.verifier, missionId: world.missionId,
    workflowRunId: world.runId, stepRunId: verdict.qa.stepRunId,
    executionGeneration: verdict.qa.executionGeneration, wakeupRequestId: wake.id, parentHeartbeatRunId: null });
  expect(allWakes).toEqual([...world.seedWakes, wake].sort((left, right) => left.id.localeCompare(right.id)));
  return { completion, wake };
}
