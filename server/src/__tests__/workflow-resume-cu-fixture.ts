import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import express from "express";
import { actorMiddleware } from "../middleware/auth.js";
import { boardMutationGuard } from "../middleware/board-mutation-guard.js";
import { workflowResumeRoutes } from "../routes/workflow-resume.js";
import { startExecutionDefinitionFixture, seedCompanyWithMission, seedWorkflowDefinition,
  seedWorkflowRun, type ExecutionDefinitionFixtureDb } from "./helpers/workflow-execution-definition-fixture.js";

export const digest = (raw: Buffer | string) => createHash("sha256").update(raw).digest("hex");
// Python's media projection preserves float tokens (2.0), unlike JS JSON.stringify (2).
export const encode = (value: unknown) => Buffer.from(JSON.stringify(value).replace(/"duration_sec":(\d+)([,}])/g, '"duration_sec":$1.0$2'));
export async function cuDatabase() {
  const fixture = await startExecutionDefinitionFixture("cu-evidence-");
  if (!fixture.supported) throw new Error(fixture.reason); // Mandatory proof: never silently skip.
  return fixture;
}
export async function cuCase(fixture: ExecutionDefinitionFixtureDb) {
  const { sql } = fixture;
  const company = await seedCompanyWithMission(sql, "CU" + randomUUID().slice(0, 8));
  const workflowId = await seedWorkflowDefinition(sql, company);
  const workflowRunId = await seedWorkflowRun(sql, { ...company, workflowId, status: "completed" });
  const issueId = randomUUID(), stepRunId = randomUUID();
  await sql`INSERT INTO issues (id,company_id,mission_id,title,status) VALUES
    (${issueId},${company.companyId},${company.missionId},'CU producer','done')`;
  await sql`INSERT INTO workflow_step_runs (id,workflow_run_id,step_id,issue_id,status,execution_generation)
    VALUES (${stepRunId},${workflowRunId},'clips',${issueId},'completed',2)`;
  const root = await mkdtemp(path.join(await realpath(tmpdir()), "cu-connected-"));
  const objects = path.join(root, "objects"), evidence = path.join(root, "evidence");
  await mkdir(objects, { mode: 0o700 }); await mkdir(evidence, { mode: 0o700 });
  const videoPath = path.join(root, "portrait.mp4"), imagePath = path.join(root, "screen.png");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=90x160:r=25", "-t", "2",
    "-c:v", "libx264", "-pix_fmt", "yuv420p", videoPath]);
  execFileSync("ffmpeg", ["-v", "error", "-i", videoPath, "-frames:v", "1", imagePath]);
  const video = await readFile(videoPath), screenshot = await readFile(imagePath);
  const runRoot = `shorts/runs/${workflowRunId}/`;
  const specObject = runRoot + "spec.json", planObject = runRoot + "plan.json", sourceObject = runRoot + "source.png";
  const spec = encode({ schema: "shorts.flow-clip-spec.v1", run_id: workflowRunId,
    clips: [{ frame_no: 1, image_object: sourceObject, motion: "fixture only", out: "clip-001.mp4" }] });
  const plan = encode({ schema: "shorts.keyframe-plan.v1", keyframes: [
    { frame_no: 1, start_sec: 0, end_sec: 1, duration_sec: 1, aspect_ratio: "9:16" }] });
  const historical = new Date(Date.now() - 3600_000).toISOString();
  const finishedAt = new Date(Date.now() - 2700_000).toISOString();
  const job = { schema: "shorts.flow-runner-job.v3", job_id: randomUUID(), company_id: company.companyId,
    mission_id: company.missionId, workflow_run_id: workflowRunId, step_run_id: stepRunId, step_id: "clips",
    issue_id: issueId, execution_generation: 2, attempt: 1, max_attempts: 1, type: "flow_clips_computer_use",
    mode: "reuse", worker_host_id: "fixture-host", clips_spec_object: specObject, spec_sha256: digest(spec),
    expires_at: new Date(Date.now() - 1800_000).toISOString(), budget: { max_clips: 1, max_credits_total: 5 },
    report: { issue_id: issueId } };
  const scope = Object.fromEntries(["job_id", "company_id", "mission_id", "workflow_run_id", "step_run_id",
    "step_id", "issue_id", "execution_generation", "attempt", "spec_sha256"].map(k => [k, job[k as keyof typeof job]]));
  const inputs = { schema: "shorts.cu-inputs.v1", scope, spec: { object: specObject, sha256: digest(spec) },
    plan: { object: planObject, sha256: digest(plan) }, sources: [{ frame: 1, object: sourceObject, sha256: digest(screenshot) }] };
  const queue = `shorts/cu-v3/${company.companyId}/${workflowRunId}/${job.job_id}/`;
  const clip = { frame: 1, object: queue + `clips/${digest(video)}.mp4`, source_object: sourceObject,
    source_sha256: digest(screenshot), file_sha256: digest(video), provenance_record: "prov-1", card_id: "card-1",
    generation_id: "gen-1", download_id: "download-1", duration_sec: 2, required_sec: 1.4, width: 90, height: 160, bytes: video.length };
  const event = { event_id: "event-1", amount: 3, evidence_record: "credit-1", generation_id: "gen-1", card_id: "card-1", origin: "historical" };
  const claimId = randomUUID();
  const manifest = { schema: "shorts.cu-manifest.v1", scope, claim_id: claimId, inputs, clips: [clip],
    credits: { historical: 3, total_new: 0, total: 3, events: [event] } };
  const put = async (key: string, raw: Buffer) => {
    const destination = path.join(objects, key); await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, raw);
  };
  await put(specObject, spec); await put(planObject, plan); await put(sourceObject, screenshot);
  await put(clip.object, video); await put(queue + "manifest.json", encode(manifest));
  await put(queue + "claim.json", encode({ schema: "shorts.cu-claim.v1", scope, claim_id: claimId,
    owner_id: "fixture-owner", host_id: job.worker_host_id, expires_at: job.expires_at }));
  await put(queue + "result.json", encode({ schema: "shorts.flow-runner-result.v3", scope, claim_id: claimId,
    status: "ok", manifest_key: queue + "manifest.json", manifest_sha256: digest(encode(manifest)), finished_at: finishedAt, code: "ok" }));
  const base = `/companies/${company.companyId}/missions/${company.missionId}`;
  const observerUrl = base + `/workflow-cu-jobs/${job.job_id}/observations`;
  const intakeUrl = base + "/workflow-late-evidence-submissions";
  const common = { jobId: job.job_id, observedAt: historical, screenshotBase64: screenshot.toString("base64") };
  const { object: _object, provenance_record: _record, duration_sec: _duration, required_sec: _required,
    width: _width, height: _height, bytes: _bytes, ...provenanceFields } = clip;
  const { evidence_record: _evidence, ...creditFields } = event;
  const observations = [
    { ...common, recordId: "prov-1", kind: "provenance", fields: { ...provenanceFields,
      comparison: { source_matches: true, download_matches: true, reviewed_at: historical } } },
    { ...common, recordId: "credit-1", kind: "credit", fields: creditFields },
    { ...common, recordId: "budget-1", kind: "budget", fields: { complete: true, events: [event] } },
  ];
  const principal = { id: "fixture-observer", tokenSha256: digest("observer-secret"), observationKind: "computer_use_observation",
    grants: [{ companyId: company.companyId, jobId: job.job_id, executionGeneration: 2 }] };
  return { ...company, root, objects, evidence, job, inputs, scope, screenshot, video, spec, planObject, specObject,
    put, queue, manifest, clip, observations, principal, observerUrl, intakeUrl,
    intake: { jobId: job.job_id, idempotencyKey: randomUUID(), manifestObject: queue + "manifest.json", manifestSha256: digest(encode(manifest)) },
    cleanup: () => rm(root, { recursive: true, force: true }) };
}
export type CuCase = Awaited<ReturnType<typeof cuCase>>;
export function cuApp(fixture: ExecutionDefinitionFixtureDb, c: CuCase) {
  const app = express(); app.use(express.json({ limit: "12mb" }));
  app.use(actorMiddleware(fixture.db, { deploymentMode: "authenticated", resolveSession: async req =>
    req.header("x-fixture-board") ? { user: { id: "cu-board" }, session: {} } as never : null }));
  app.use(boardMutationGuard()); app.use(workflowResumeRoutes(fixture.db));
  app.use((error: any, _req: any, res: any, _next: any) => res.status(error.status ?? 500).json({ error: error.message }));
  return app;
}
export async function boardMembership(fixture: ExecutionDefinitionFixtureDb, c: CuCase) {
  await fixture.sql`INSERT INTO company_memberships (company_id,principal_type,principal_id,status,membership_role)
    VALUES (${c.companyId},'user','cu-board','active','owner')`;
}
export function configureCu(c: CuCase) {
  process.env.PAPERCLIP_CU_OBSERVERS_JSON = JSON.stringify([c.principal]);
  process.env.PAPERCLIP_CU_LOCAL_OBJECT_ROOT = c.objects;
  process.env.PAPERCLIP_CU_EVIDENCE_ROOT = c.evidence;
  process.env.PAPERCLIP_CU_RECEIVER_PYTHON = execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  // External Task1 checkout is test configuration too: no developer-home fallback or silent skip.
  const script = process.env.CU_TEST_RECEIVER_SCRIPT;
  if (!script || !path.isAbsolute(script)) throw new Error("CU_TEST_RECEIVER_SCRIPT must name the absolute Task1 CLI");
  process.env.PAPERCLIP_CU_RECEIVER_SCRIPT = script;
}
