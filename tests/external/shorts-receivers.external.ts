// OPT-IN EXTERNAL integration: REAL producer semantics for the shorts CU evidence boundary.
// Ordinary CI never loads this file — default Vitest discovery excludes tests/external and
// *.external.ts on purpose. Run only via `pnpm test:shorts-external` after exporting:
//   CU_TEST_RECEIVER_SCRIPT  absolute path to scripts/shorts-flow-runner/cu_receiver_cli.py
//   CU_TEST_PYTHON           absolute path to the Python interpreter executable
//   SHORTS_OPERATIONS_ROOT   absolute path to the shorts operations checkout (cu_reuse_sketch.py)
// Missing or invalid configuration fails loudly; there are no skips and no silent defaults.
// Ordinary CI proves only the consumer contract (checked-in fixture bytes + producer test
// doubles + durable DB/FS readback); real Python refusal/intake semantics live solely here.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { accessSync, constants, mkdtempSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, test } from "vitest";
import { parseLocalSketchReceipt } from "../../server/src/services/workflow/resume/local-sketch.js";
import { LOCAL_SKETCH_MODE, LOCAL_SKETCH_RECEIPT_SCHEMA } from "../../server/src/services/workflow/resume/local-sketch-types.js";
import { bindCuJob } from "../../server/src/services/workflow-resume-cu-evidence.js";
import { createCuObjectReader } from "../../server/src/services/workflow-resume-cu-objects.js";
import { cuApp, cuCase, cuDatabase, boardMembership, configureCu, type CuCase } from "../../server/src/__tests__/workflow-resume-cu-fixture.js";
import { SYNTHETIC_CLAIM_ID, SYNTHETIC_SCOPE, buildFixtureInputDocument } from "../../server/src/__tests__/helpers/shorts-local-sketch-fixture.js";

function requireExternalFile(name: string, executable = false): string {
  const value = process.env[name];
  if (!value || !path.isAbsolute(value)) {
    throw new Error(`external suite requires ${name} to be set to an absolute path (no skips or silent defaults)`);
  }
  if (executable) {
    try { accessSync(value, constants.X_OK); } catch { throw new Error(`external suite requires ${name} to be an existing executable: ${value}`); }
  } else if (!existsSync(value)) {
    throw new Error(`external suite requires ${name} to be an existing file: ${value}`);
  }
  return value;
}

let config: { python: string; receiverScript: string; sketchScript: string };
let fixture: Awaited<ReturnType<typeof cuDatabase>>;
beforeAll(async () => {
  const python = requireExternalFile("CU_TEST_PYTHON", true);
  const receiverScript = requireExternalFile("CU_TEST_RECEIVER_SCRIPT");
  const operationsRoot = requireExternalFile("SHORTS_OPERATIONS_ROOT");
  const sketchScript = path.join(operationsRoot, "scripts", "shorts-flow-runner", "cu_reuse_sketch.py");
  if (!existsSync(sketchScript)) throw new Error(`external suite requires cu_reuse_sketch.py under SHORTS_OPERATIONS_ROOT: ${sketchScript}`);
  config = { python, receiverScript, sketchScript };
  fixture = await cuDatabase();
}, 120_000);
afterAll(async () => { await fixture?.cleanup(); });

/** Real receiver configured explicitly (never env-implicit): actual DB, board, observations, intake. */
async function realReceiver(change: (c: CuCase) => Promise<void>) {
  const c = await cuCase(fixture);
  try {
    configureCu(c, { executable: config.python, script: config.receiverScript });
    await boardMembership(fixture, c);
    await bindCuJob(fixture.db, { job: c.job, planObject: c.planObject },
      { readObject: createCuObjectReader(fixture.db), creatorId: "controller" });
    await change(c);
  } finally { await c.cleanup(); }
}

// supertest resolves only under server/node_modules (pnpm layout), so the external suite —
// living outside the server package — drives the actual express app over ephemeral-port fetch.
type App = ReturnType<typeof cuApp>;
async function listen(app: App) {
  const server = app.listen(0, "127.0.0.1");
  await new Promise<void>((resolve) => server.once("listening", resolve));
  const port = (server.address() as { port: number }).port;
  return {
    post: async (url: string, body: unknown, headers: Record<string, string> = {}) => {
      const reply = await fetch(`http://127.0.0.1:${port}${url}`, {
        method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body),
      });
      const text = await reply.text();
      return { status: reply.status, body: text ? JSON.parse(text) : null as unknown };
    },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
async function admit(c: CuCase) {
  const app = await listen(cuApp(fixture, c));
  try {
    for (const observation of c.observations) {
      const reply = await app.post(c.observerUrl, observation, { Authorization: "Bearer observer-secret" });
      expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    }
    return await app.post(c.intakeUrl, c.intake, { "x-fixture-board": "1", Origin: "http://localhost:3100" });
  } finally { await app.close(); }
}
async function blockedRow(reply: Awaited<ReturnType<typeof admit>>) {
  expect(reply.status, JSON.stringify(reply.body)).toBe(201);
  expect(reply.body.state).toBe("blocked"); expect(reply.body.result).toBeNull(); expect(reply.body.resultSha256).toBeNull();
  const [row] = await fixture.sql`SELECT * FROM workflow_late_evidence_submissions WHERE id=${reply.body.id}`;
  expect(row.cu_result_base64).toBeNull(); expect(row.artifact_id).toBeNull(); expect(row.verified_at).toBeNull();
  return row;
}

test("real Python receiver success smoke: verified durable readback", async () => {
  await realReceiver(async c => {
    const reply = await admit(c);
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    expect(reply.body.state).toBe("verified");
    expect(reply.body.code).toBe("cu_artifact_verified");
    expect(reply.body.result.scope).toEqual(c.scope);
    const status = JSON.parse(await readFile(`${c.evidence}/${reply.body.id}/result/receiver-status.v1.json`, "utf8"));
    expect(status).toMatchObject({ schema: "shorts.cu-receiver-status.v1", status: "verified", code: null });
  });
});
test.each(["missing-comparison", "false-comparison", "missing-budget", "incomplete-budget", "missing-complete", "missing-credit"])("real receiver never invents success: %s", async kind => {
  await realReceiver(async c => {
    const observations = c.observations as any[];
    if (kind === "missing-comparison") delete observations[0].fields.comparison;
    if (kind === "false-comparison") observations[0].fields.comparison.source_matches = false;
    if (kind === "missing-budget") observations.splice(2, 1);
    if (kind === "incomplete-budget") observations[2].fields.complete = false;
    if (kind === "missing-complete") delete observations[2].fields.complete;
    if (kind === "missing-credit") observations.splice(1, 1);
    const row = await blockedRow(await admit(c));
    // The real receiver ran, durably refused (nonzero exit + written non-verified status)
    // and the runtime kept the blocked state with no invented result.
    const status = JSON.parse(await readFile(`${c.evidence}/${row.id}/result/receiver-status.v1.json`, "utf8"));
    expect(status.schema).toBe("shorts.cu-receiver-status.v1");
    expect(status.status).not.toBe("verified");
    const snapshot = JSON.parse(Buffer.from(row.cu_snapshot_base64, "base64").toString());
    if (kind === "missing-comparison") expect(snapshot.records[0]).not.toHaveProperty("comparison");
    if (kind === "false-comparison") expect(snapshot.records[0].comparison.source_matches).toBe(false);
    if (kind === "missing-budget") expect(snapshot.budget).toBeNull();
    if (kind === "incomplete-budget") expect(snapshot.budget.complete).toBe(false);
  });
});
test("real receiver refuses mutated snapshot bytes in place", async () => {
  await realReceiver(async c => {
    // Snapshot-byte verification belongs to the real Python snapshot verifier, not to the
    // ordinary-CI test double: this wrapper corrupts the exported snapshot on disk, then
    // replaces itself with the real receiver CLI.
    const wrapper = path.join(c.root, "snapshot-mutator.py");
    writeFileSync(wrapper, `import os, sys
argv = sys.argv[1:]
snapshot = argv[argv.index("--snapshot") + 1]
with open(snapshot, "ab") as handle: handle.write(b" ")
os.execv(sys.executable, [sys.executable, ${JSON.stringify(config.receiverScript)}, *argv])
`);
    configureCu(c, { executable: config.python, script: wrapper });
    const row = await blockedRow(await admit(c));
    const status = JSON.parse(await readFile(`${c.evidence}/${row.id}/result/receiver-status.v1.json`, "utf8"));
    expect(status.schema).toBe("shorts.cu-receiver-status.v1");
    expect(status.status).not.toBe("verified");
  });
});
test("real sketch intake rejects tampered synthetic clip bytes via nonzero exit and no receipt", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sketch-external-tampered-"));
  try {
    const doc = buildFixtureInputDocument();
    doc.clip_bytes["1"] = Buffer.from("tampered synthetic frame bytes").toString("base64");
    const inputPath = path.join(dir, "input.json");
    writeFileSync(inputPath, JSON.stringify(doc));
    let failed = false;
    try {
      execFileSync(config.python, [config.sketchScript, "--input", inputPath, "--output-dir", path.join(dir, "out")], { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) { failed = true; expect((error as { status?: number }).status).not.toBe(0); }
    expect(failed).toBe(true);
    expect(() => readFileSync(path.join(dir, "out", "receipt.json"))).toThrow();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
test("real sketch intake valid receipt smoke parses to the fixture scope", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "sketch-external-valid-"));
  try {
    const inputPath = path.join(dir, "input.json");
    writeFileSync(inputPath, JSON.stringify(buildFixtureInputDocument()));
    execFileSync(config.python, [config.sketchScript, "--input", inputPath, "--output-dir", path.join(dir, "out")], { stdio: ["ignore", "pipe", "pipe"] });
    const receiptBytes = new Uint8Array(readFileSync(path.join(dir, "out", "receipt.json")));
    const parsed = parseLocalSketchReceipt(receiptBytes);
    expect(parsed.receipt.schema).toBe(LOCAL_SKETCH_RECEIPT_SCHEMA);
    expect(parsed.receipt.mode).toBe(LOCAL_SKETCH_MODE);
    expect(parsed.receipt.scope).toEqual(SYNTHETIC_SCOPE);
    expect(parsed.receipt.claim_id).toBe(SYNTHETIC_CLAIM_ID);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
