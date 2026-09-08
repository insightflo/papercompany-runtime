import { randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, test } from "vitest";
import { cuDatabase, configureCu } from "./workflow-resume-cu-fixture.js";
import { pendingExactCase, registerExact, resolveExact, type ExactCase } from "./helpers/workflow-exact-artifact-fixture.js";
let f: Awaited<ReturnType<typeof cuDatabase>>;
const cases: ExactCase[] = [];
beforeAll(async () => { f = await cuDatabase(); }, 120_000);
afterAll(async () => { for (const c of cases) await c.cleanup(); await f?.cleanup(); });
async function pending() { const c = await pendingExactCase(f); cases.push(c); return c; }
const rejected = (c: ExactCase) => expect(resolveExact(f, c)).rejects.toThrow("Workflow IF condition failed:");

test("delayed old completed attempt sharing an issue registers old identity but cannot feed newest IF", async () => {
  const c = await pending();
  const newer = randomUUID();
  await f.sql`INSERT INTO workflow_step_runs(id,workflow_run_id,step_id,issue_id,status,execution_generation,iteration_index,started_at,completed_at)
    VALUES(${newer},${c.job.workflow_run_id},'clips',${c.job.issue_id},'completed',2,1,now()-interval '30 minutes',now())`;
  const product = await registerExact(c);
  expect(product.metadata).toMatchObject({ exactProducer: { stepRunId: c.job.step_run_id } });
  await rejected(c);
  await f.sql`UPDATE workflow_step_runs SET status='running' WHERE id=${newer}`;
  await rejected(c);
  await f.sql`DELETE FROM workflow_step_runs WHERE id=${newer}`;
  expect((await resolveExact(f, c)).size).toBe(1);
  await f.sql`UPDATE workflow_step_runs SET execution_generation=3 WHERE id=${c.job.step_run_id}`;
  await rejected(c);
}, 120_000);

test("DB linkage is authoritative: pending/blocked/foreign/missing pins and stripped/malformed markers never downgrade to legacy", async () => {
  const c = await pending(), product = await registerExact(c);
  for (const state of ["pending_readback", "blocked"]) {
    await f.sql`UPDATE workflow_late_evidence_submissions SET state=${state} WHERE id=${c.view.id}`;
    await rejected(c);
  }
  await f.sql`UPDATE workflow_late_evidence_submissions SET state='verified' WHERE id=${c.view.id}`;
  for (const metadata of [{ path: c.artifactPath }, { path: c.artifactPath, registeredVia: "workflow_cu_exact_v1", exactProducer: {} }]) {
    await f.sql`UPDATE issue_work_products SET metadata=${JSON.stringify(metadata)} WHERE id=${product.id}`;
    await rejected(c);
  }
  await f.sql`UPDATE issue_work_products SET metadata=${JSON.stringify(product.metadata)} WHERE id=${product.id}`;
  await f.sql`UPDATE workflow_late_evidence_submissions SET verified_at=null WHERE id=${c.view.id}`;
  await rejected(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET verified_at=now(),readback_hash=${"0".repeat(64)} WHERE id=${c.view.id}`;
  await rejected(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET readback_hash=cu_result_sha256,artifact_id=null WHERE id=${c.view.id}`;
  await rejected(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET artifact_id=${product.id} WHERE id=${c.view.id}`;
  const foreign = await pending();
  configureCu(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET artifact_id=null WHERE id=${c.view.id}`;
  await f.sql`UPDATE workflow_late_evidence_submissions SET artifact_id=${product.id} WHERE id=${foreign.view.id}`;
  await rejected(c);
  await f.sql`UPDATE workflow_late_evidence_submissions SET artifact_id=null WHERE id=${foreign.view.id}`;
  await f.sql`UPDATE workflow_late_evidence_submissions SET artifact_id=${product.id} WHERE id=${c.view.id}`;
  expect((await resolveExact(f, c)).size).toBe(1);
  await writeFile(c.artifactPath, c.raw.toString().replace('"ok"', '"no"'));
  await rejected(c);
}, 120_000);

test("legacy product ranking cannot select an older producer issue merely through a primary/recent artifact", async () => {
  const c = await pending(); await registerExact(c);
  const issueId = randomUUID(), newer = randomUUID();
  const file = `${c.root}/legacy-current.json`;
  await writeFile(file, '{"legacy":"current"}');
  await f.sql`UPDATE issue_work_products SET is_primary=true,updated_at=now()+interval '1 hour' WHERE issue_id=${c.job.issue_id}`;
  await f.sql`INSERT INTO issues(id,company_id,mission_id,title,status) VALUES(${issueId},${c.companyId},${c.missionId},'new attempt','done')`;
  await f.sql`INSERT INTO workflow_step_runs(id,workflow_run_id,step_id,issue_id,status,iteration_index,started_at)
    VALUES(${newer},${c.job.workflow_run_id},'clips',${issueId},'completed',1,now()-interval '30 minutes')`;
  await f.sql`INSERT INTO issue_work_products(company_id,issue_id,type,provider,title,status,metadata)
    VALUES(${c.companyId},${issueId},'artifact','local_file','clips-result.v1.json','active',${JSON.stringify({ path: file })})`;
  expect([...(await resolveExact(f, c)).values()]).toEqual([{ legacy: "current" }]);
}, 120_000);

test("attempt selection precedes product ranking; latest running/null start and equal-ranked attempts fail closed", async () => {
  const c = await pending(); await registerExact(c);
  const newer = randomUUID();
  await f.sql`INSERT INTO workflow_step_runs(id,workflow_run_id,step_id,issue_id,status,iteration_index,started_at)
    VALUES(${newer},${c.job.workflow_run_id},'clips',${c.job.issue_id},'running',1,now())`;
  await rejected(c);
  await f.sql`UPDATE workflow_step_runs SET status='completed',started_at=null WHERE id=${newer}`;
  await rejected(c);
  await f.sql`UPDATE workflow_step_runs SET iteration_index=0,started_at=(SELECT started_at FROM workflow_step_runs WHERE id=${c.job.step_run_id}) WHERE id=${newer}`;
  await rejected(c);
}, 120_000);
