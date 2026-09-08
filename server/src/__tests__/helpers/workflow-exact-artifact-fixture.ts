import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { issues } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import request from "supertest";
import { expect } from "vitest";
import { bindCuJob, admitCuEvidence } from "../../services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../../services/workflow-resume-cu-objects.js";
import { registerWorkflowArtifactWithStorage } from "../../services/workflow/registered-artifact-storage.js";
import { resolveWorkflowConditionSources } from "../../services/workflow/control-flow/condition-source-resolver.js";
import { cuCase, cuApp, configureCu, type cuDatabase } from "../workflow-resume-cu-fixture.js";

export type ExactFixture = Awaited<ReturnType<typeof cuDatabase>>;
export async function connectedExactCase(f: ExactFixture) {
  const c = await cuCase(f); configureCu(c);
  await f.sql`UPDATE workflow_step_runs SET started_at=now()-interval '2 hours', completed_at=now()-interval '1 hour'
    WHERE id=${c.job.step_run_id}`;
  await bindCuJob(f.db, { job: c.job, planObject: c.planObject },
    { readObject: createCuObjectReader(f.db), creatorId: "fixture-controller" });
  for (const observation of c.observations) {
    const reply = await request(cuApp(f, c)).post(c.observerUrl).set("Authorization", "Bearer observer-secret").send(observation);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  }
  const view = await admitCuEvidence(f.db, { companyId: c.companyId, missionId: c.missionId }, c.intake, "cu-board");
  const artifactPath = `${c.evidence}/${view.id}/result/clips-result.v1.json`;
  const raw = await readFile(artifactPath);
  const issue = (await f.db.select().from(issues).where(eq(issues.id, c.job.issue_id)))[0]!;
  const exactProducer = { companyId: c.companyId, missionId: c.missionId, workflowRunId: c.job.workflow_run_id,
    stepRunId: c.job.step_run_id, stepId: "clips", issueId: c.job.issue_id, executionGeneration: 2,
    specSha256: c.job.spec_sha256, submissionId: view.id };
  const input = { db: f.db, issue, actor: { actorType: "user" as const, actorId: "cu-board", agentId: null, runId: null },
    data: { path: artifactPath, type: "artifact" as const, isPrimary: false }, exactProducer };
  return { ...c, view, artifactPath, raw, input };
}
export type ExactCase = Awaited<ReturnType<typeof connectedExactCase>>;
export async function pendingExactCase(f: ExactFixture) {
  const c = await connectedExactCase(f);
  // Fixture reset only: retain the actual receiver's immutable pins and durable file.
  const [row] = await f.sql`SELECT artifact_id FROM workflow_late_evidence_submissions WHERE id=${c.view.id}`;
  await f.sql`UPDATE workflow_late_evidence_submissions SET state='pending_readback',code='cu_receiver_ok',
    artifact_id=null,readback_hash=null,verified_at=null WHERE id=${c.view.id}`;
  if (row.artifact_id) await f.sql`DELETE FROM issue_work_products WHERE id=${row.artifact_id}`;
  return c;
}
export const registerExact = (c: ExactCase) => registerWorkflowArtifactWithStorage(c.input);
export function resolveExact(f: ExactFixture, c: ExactCase) {
  return resolveWorkflowConditionSources({ db: f.db, run: { id: c.job.workflow_run_id, companyId: c.companyId },
    ifStep: { id: "gate", dependencies: ["clips"] }, workflowSteps: [{ id: "clips" }, { id: "gate", dependencies: ["clips"] }],
    sources: [{ kind: "work_product_json", stepId: "clips", title: "clips-result.v1.json", path: "$.status" }] });
}
export async function remoteStorage(f: ExactFixture, c: ExactCase) {
  const access = randomUUID(), secret = randomUUID();
  await f.sql`INSERT INTO company_secrets(id,company_id,name,provider) VALUES
    (${access},${c.companyId},'access','local_encrypted'),(${secret},${c.companyId},'secret','local_encrypted')`;
  await f.sql`INSERT INTO company_work_product_storages(company_id,provider,endpoint,region,bucket,key_prefix,access_key_secret_id,secret_access_key_secret_id)
    VALUES(${c.companyId},'s3','https://storage.example.test','us-east-1','fixture','exact',${access},${secret})`;
}
export async function controlState(f: ExactFixture, c: ExactCase) {
  const result: Record<string, unknown> = {};
  for (const table of ["issues", "workflow_runs", "missions", "heartbeat_runs", "agent_wakeup_requests", "workflow_resume_executions"]) {
    result[table] = await f.sql.unsafe(`SELECT * FROM ${table} WHERE company_id=$1 ORDER BY id`, [c.companyId]);
  }
  result.steps = await f.sql`SELECT * FROM workflow_step_runs WHERE workflow_run_id=${c.job.workflow_run_id} ORDER BY id`;
  return result;
}
