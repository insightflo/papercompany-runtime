// scripts/quality/evidence.test.mjs
//
// [TEST DATA — 운영 기본값 아님] T6 evidence.mjs 스크립트 계약 검증.
// 결정적 stub HTTP 서버(실제 DB 없음)로 스크립트의 요청 경로·헤더·버전 JSON 본문과
// CLI 출력/종료 코드만 검증한다. 서버 저장 동작은 vitest(native 테스트)가 증명한다.
// [구분] 이 테스트는 "스크립트 클라이언트 계약"이지 실제 에이전트 판단 검증이 아니다.
// CLI stdout 은 표시용이며 어떤 제어 신호도 아니다(서버는 stdout 을 읽지 않는다).

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { openCase, readCheck, submitResults, submitCandidate, verifyEvaluation, planQaInput, planQaRead, planQaSubmit } from "./evidence.mjs";

const ISSUE = "11111111-1111-4111-8111-111111111111";
const EVAL = "22222222-2222-4222-8222-222222222222";
const INV = "33333333-3333-4333-8333-333333333333";
const KEY = "test-key";
const RUN = "44444444-4444-4444-8444-444444444444";

function startedStub() {
  const seen = [];
  let responder = () => ({ status: 201, body: { data: {} } });
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8") || "{}";
      seen.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization ?? null,
        runHeader: req.headers["x-paperclip-run-id"] ?? null,
        body: body === "{}" ? {} : JSON.parse(body),
      });
      const out = responder(seen.at(-1));
      res.writeHead(out.status, { "content-type": "application/json" });
      res.end(JSON.stringify(out.body));
    });
  });
  const listening = once(server, "listening");
  server.listen(0, "127.0.0.1");
  return {
    server,
    seen,
    ready: () => listening,
    respond(next) { responder = next; },
    get url() { return `http://127.0.0.1:${server.address().port}`; },
    async close() { server.closeAllConnections(); server.close(); await once(server, "close"); },
  };
}

function envFor(url) {
  return { ...process.env, PAPERCLIP_API_URL: url, PAPERCLIP_API_KEY: KEY, PAPERCLIP_RUN_ID: RUN };
}

/** 동기 spawn 은 부모 이벤트루프를 막아 stub 서버가 응답하지 못하게 하므로 비동기 spawn 을 쓴다. */
async function runCli(args, env) {
  const child = spawn(process.execPath, [path.join(import.meta.dirname, "evidence.mjs"), ...args], { env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const [code] = await once(child, "close");
  return { status: code, stdout, stderr };
}

test("client commands POST versioned JSON to the dedicated API with bearer key and run header", async (t) => {
  const stub = startedStub();
  await stub.ready();
  t.after(() => stub.close());
  const base = { url: stub.url, key: KEY, runId: RUN };
  stub.respond(() => ({ status: 201, body: { data: { invocationId: INV, inputRef: { attachmentId: ISSUE, sha256: "ab".repeat(32) } } } }));
  const opened = await openCase(base, { issueId: ISSUE, evaluationId: EVAL, caseId: "f1-0123abcd", variant: "baseline" });
  assert.equal(opened.invocationId, INV);

  stub.respond(() => ({ status: 201, body: { data: { readRef: { attachmentId: ISSUE, sha256: "cd".repeat(32) }, values: ["goal"] } } }));
  const read = await readCheck(base, { issueId: ISSUE, evaluationId: EVAL, invocationId: INV, checkId: "c1", pointers: ["/plan/goal"] });
  assert.deepEqual(read.values, ["goal"]);

  const results = [{ checkId: "c1", status: "satisfied", readRef: read.readRef, evidence: [] }];
  stub.respond(() => ({ status: 201, body: { data: { submissionRef: { attachmentId: ISSUE, sha256: "ef".repeat(32) } } } }));
  const submitted = await submitResults(base, { issueId: ISSUE, evaluationId: EVAL, invocationId: INV, schemaVersion: 1, results });
  assert.ok(submitted.submissionRef.sha256);

  stub.respond(() => ({ status: 200, body: { data: { status: "pass", evidenceRefId: "er1" } } }));
  const verdict = await verifyEvaluation(base, { issueId: ISSUE, evaluationId: EVAL });
  assert.equal(verdict.status, "pass");

  stub.respond(() => ({ status: 201, body: { data: { candidateVersionId: "v1", bodyRef: { attachmentId: ISSUE, sha256: "ab".repeat(32) }, evaluationId: EVAL, verifierIssueId: ISSUE, verifierStepRunId: "s1" } } }));
  const candidate = await submitCandidate(base, { issueId: ISSUE, schemaVersion: 1, checks: [{ checkId: "add-1", requirementRefs: [], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "x" }] });
  assert.equal(candidate.evaluationId, EVAL);

  const want = [
    ["POST", `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/cases/f1-0123abcd/baseline/open`, {}],
    ["POST", `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/invocations/${INV}/read`, { checkId: "c1", pointers: ["/plan/goal"] }],
    ["POST", `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/invocations/${INV}/results`, { schemaVersion: 1, results }],
    ["POST", `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/verify`, {}],
    ["POST", `/api/issues/${ISSUE}/quality/candidates`, { schemaVersion: 1, checks: [{ checkId: "add-1", requirementRefs: [], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "x" }] }],
  ];
  assert.deepEqual(stub.seen.map((r) => [r.method, r.url, r.body]), want);
  for (const r of stub.seen) {
    assert.equal(r.auth, `Bearer ${KEY}`);
    assert.equal(r.runHeader, RUN);
  }
});

test("submit returns structured MissingEvidence without throwing", async (t) => {
  const stub = startedStub();
  await stub.ready();
  t.after(() => stub.close());
  stub.respond(() => ({ status: 200, body: { data: { status: "missing_evidence", reasons: [{ code: "quality_read_receipt_mismatch", checkId: "c1", requiredKind: "read", expectedHash: null }], submission: { method: "POST", path: `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/invocations/${INV}/results`, schemaVersion: 1 }, remainingResubmissions: 1 } } }));
  const out = await submitResults({ url: stub.url, key: KEY, runId: RUN }, { issueId: ISSUE, evaluationId: EVAL, invocationId: INV, schemaVersion: 1, results: [] });
  assert.equal(out.status, "missing_evidence");
  assert.equal(out.remainingResubmissions, 1);
});

test("CLI candidate --file prints versioned JSON and exits 0; missing permissions never retry", async (t) => {
  const stub = startedStub();
  await stub.ready();
  t.after(() => stub.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "quality-t6-script-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "candidate.json");
  await writeFile(file, JSON.stringify({ checks: [{ checkId: "add-1", requirementRefs: [], applicability: { op: "always" }, expectedEvidenceKinds: ["plan_document"], instructions: "추가 검사" }] }));
  stub.respond(() => ({ status: 201, body: { data: { candidateVersionId: "v1", bodyRef: { attachmentId: ISSUE, sha256: "ab".repeat(32) }, evaluationId: EVAL, verifierIssueId: ISSUE, verifierStepRunId: "s1" } } }));
  const ok = await runCli(["candidate", "--issue", ISSUE, "--file", file], envFor(stub.url));
  assert.equal(ok.status, 0, ok.stderr);
  const printed = JSON.parse(ok.stdout);
  assert.equal(printed.evaluationId, EVAL);
  assert.equal(stub.seen.length, 1);

  // 401: 권한 없음 — 자동 설치/수정/재시도 없이 즉시 실패.
  stub.respond(() => ({ status: 401, body: { error: "Unauthorized" } }));
  const denied = await runCli(["candidate", "--issue", ISSUE, "--file", file], envFor(stub.url));
  assert.equal(denied.status, 1);
  assert.equal(stub.seen.length, 2);
});

test("CLI verify exits 2 with structured MissingEvidence JSON on stdout (display only)", async (t) => {
  const stub = startedStub();
  await stub.ready();
  t.after(() => stub.close());
  stub.respond(() => ({ status: 200, body: { data: { status: "missing_evidence", reasons: [{ code: "quality_invocation_missing", checkId: null, requiredKind: "invocation", expectedHash: null }], submission: { method: "POST", path: `/api/issues/${ISSUE}/quality/evaluations/${EVAL}/v1/cases/f1-x/baseline/open`, schemaVersion: 1 }, remainingResubmissions: 1 } } }));
  const run = await runCli(["verify", "--issue", ISSUE, "--evaluation", EVAL], envFor(stub.url));
  assert.equal(run.status, 2);
  const printed = JSON.parse(run.stdout);
  assert.equal(printed.status, "missing_evidence");
});

test("PLAN-QA client keeps server scope and exact v2 submission/response contracts", async (t) => {
  const stub = startedStub();
  await stub.ready(); t.after(() => stub.close());
  const config = { url: stub.url, key: KEY, runId: RUN };
  const base = `/api/issues/${ISSUE}/mission-plan-qa`;
  stub.respond(() => ({ status: 200, body: { data: { scope: { heartbeatRunId: RUN }, manifest: { checks: [] } } } }));
  assert.deepEqual((await planQaInput(config, { issueId: ISSUE })).scope, { heartbeatRunId: RUN });
  const readRef = { attachmentId: ISSUE, sha256: "ab".repeat(32) };
  stub.respond(() => ({ status: 201, body: { data: { readRef, values: ["goal"] } } }));
  assert.deepEqual((await planQaRead(config, { issueId: ISSUE, checkId: "c1", pointers: ["/goal"] })).readRef, readRef);
  const submission = { schemaVersion: 2, verdict: "pass", diagnostics: [], checks: [{ checkId: "c1", status: "satisfied", readRef, evidence: [] }] };
  stub.respond(() => ({ status: 200, body: { status: "recorded", verdict: "pass", evidenceRefId: EVAL } }));
  assert.equal((await planQaSubmit(config, { issueId: ISSUE, submission })).evidenceRefId, EVAL);
  assert.deepEqual(stub.seen.map((r) => [r.method, r.url, r.body]), [
    ["GET", `${base}/input`, {}], ["POST", `${base}/read`, { checkId: "c1", pointers: ["/goal"] }],
    ["POST", `${base}/verdict`, submission],
  ]);
  for (const r of stub.seen) { assert.equal(r.auth, `Bearer ${KEY}`); assert.equal(r.runHeader, RUN); }
});

test("PLAN-QA CLI requires explicit version/file and never retries missing evidence or auth errors", async (t) => {
  const stub = startedStub();
  await stub.ready(); t.after(() => stub.close());
  const dir = await mkdtemp(path.join(os.tmpdir(), "quality-t8-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const file = path.join(dir, "submission.json");
  const args = ["plan-qa-submit", "--issue", ISSUE, "--file", file];
  await writeFile(file, JSON.stringify({ verdict: "pass", checks: [] }));
  assert.equal((await runCli(args, envFor(stub.url))).status, 1);
  assert.equal((await runCli(["plan-qa-read", "--issue", ISSUE, "--check", "c1"], envFor(stub.url))).status, 1);
  assert.equal(stub.seen.length, 0);
  await writeFile(file, JSON.stringify({ schemaVersion: 2, verdict: "pass", checks: [] }));
  stub.respond(() => ({ status: 200, body: { status: "missing_evidence", remainingResubmissions: 1,
    submission: { method: "POST", path: `/api/issues/${ISSUE}/mission-plan-qa/verdict`, schemaVersion: 2 } } }));
  const missing = await runCli(args, envFor(stub.url));
  assert.equal(missing.status, 2); assert.equal(JSON.parse(missing.stdout).remainingResubmissions, 1);
  for (const status of [401, 403]) {
    stub.respond(() => ({ status, body: { error: "denied" } }));
    assert.equal((await runCli(args, envFor(stub.url))).status, 1);
  }
  assert.equal(stub.seen.length, 3);
});
