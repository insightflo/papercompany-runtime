import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { chmod, lstat, mkdtemp, readFile, readdir, realpath, rm } from "node:fs/promises";
import { asc, eq } from "drizzle-orm";
import { activityLog, agentWakeupRequests, companies, heartbeatRuns, issueWorkProducts, qualityActionGroups,
  qualityEvidenceRefs, qualityPolicyUsage, workflowDefinitions, workflowRuns, workflowStepOutputBindings,
  workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { toolArtifactReceiptSchema } from "@paperclipai/shared/validators/workflow-artifact";
import { captureArtifactRoot, digest } from "../services/workflow/artifact-files.js";
import { createArtifactDirectory } from "../services/workflow/artifact-writer.js";
import { freezeArtifactAttempt } from "../services/workflow/artifact-contract-runtime.js";
import { loadExecutionDefinition } from "../services/workflow/execution-definition.js";
import { buildMissionWorkProductPaths } from "../services/work-products/output-paths.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { hashQaCorrectionPayload, type QaCorrectionPreparation } from "../services/workflow/control-flow/qa-correction-contract.js";
import { appendQaVerdict, createQaCorrectionTestDb, issueQaCorrectionFixture,
  seedQaCorrection, type CorrectionFixture } from "./helpers/qa-correction-fixture.js";

export type CommitSourceMode = "html" | "content" | "empty" | "content-only";
const inputSchema = toolArtifactReceiptSchema.options[0].shape.input;
type Input = ReturnType<typeof inputSchema.parse>;
type Request = { input: Input; requestId: string;
  artifactExecution: NonNullable<ReturnType<typeof freezeArtifactAttempt>>; [key: string]: unknown };
export interface CommitSourceCase {
  db: Db; root: string; mode: CommitSourceMode; f: CorrectionFixture; p: QaCorrectionPreparation;
  producer: Input["producer"]; text: string; productId: string; directory: string; file: string;
  files: Map<string, Buffer>; request: Request;
  history: Awaited<ReturnType<typeof issueQaCorrectionFixture>> | null;
  bundles: { directory: string; files: Map<string, Buffer> }[];
}
const mainName = "report.html", manifestName = "bundle-index.json";
const assetNames = (mode: CommitSourceMode) => mode === "html" ? ["nested/pixel.svg"]
  : mode === "content" ? Array.from({ length: 9 }, (_, i) => "img-" + i + ".png") : [];
// Independent fixture bytes and manifests: never call the patcher to derive expected output.
export function commitBuffers(mode: CommitSourceMode, text: string) {
  const names = assetNames(mode), main = Buffer.from(mode === "html"
    ? "<p>" + text + '</p><img src="assets/nested/pixel.svg">'
    : JSON.stringify({ schemaVersion: "ContentV1", title: text, summary: "Draft", tags: ["fixture"],
      blocks: names.map(assetFile => ({ type: "image", assetFile })) }));
  const files = new Map<string, Buffer>([[mainName, main]]);
  for (const name of names) files.set("assets/" + name, Buffer.from(name));
  if (mode === "html") {
    const notes = Buffer.from("source notes"); files.set("source-notes.txt", notes);
    files.set(manifestName, Buffer.from(JSON.stringify({ schemaVersion: "bundle.v1", htmlSha256: digest(main),
      assets: names.map(fileName => ({ fileName, sha256: digest(files.get("assets/" + fileName)!),
        byteSize: files.get("assets/" + fileName)!.length })),
      ancillary: [{ fileName: "source-notes.txt", sha256: digest(notes), byteSize: notes.length, role: "research" }] })));
  }
  return files;
}
export function commitFacts(files: Map<string, Buffer>) {
  return [...files].map(([relativePath, bytes]) => ({ relativePath, sha256: digest(bytes), byteSize: bytes.length,
    role: relativePath === mainName ? "main" as const : relativePath.startsWith("assets/") ? "asset" as const : "ancillary" as const,
  })).sort((a, b) => a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0);
}
function directories(files: Map<string, Buffer>, assets: boolean) {
  const names = new Set(["."]);
  if (assets) names.add("assets");
  for (const file of files.keys()) for (let d = path.posix.dirname(file); d !== "."; d = path.posix.dirname(d)) names.add(d);
  return [...names];
}
async function save(root: string, relative: string, files: Map<string, Buffer>, assets: boolean) {
  return (await createArtifactDirectory(await captureArtifactRoot(root), relative,
    [...files].map(([relative, bytes]) => ({ relative, bytes })), directories(files, assets))).path;
}
export async function createCommitSourceHarness() {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), "qa-commit-source-")));
  const owned = await createQaCorrectionTestDb();
  async function writable(target: string): Promise<void> {
    const relative = path.relative(root, target);
    if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw Error("cleanup escaped own root");
    const st = await lstat(target);
    if (st.isSymbolicLink()) return;
    await chmod(target, st.isDirectory() ? 0o700 : 0o600);
    if (st.isDirectory()) for (const name of await readdir(target)) await writable(path.join(target, name));
  }
  return { db: owned.db, connect: owned.connect, root, close: async () => {
    try { await owned.close(); } finally { await writable(root); await rm(root, { recursive: true, force: true }); }
  } };
}

async function declare(s: Omit<CommitSourceCase, "request">): Promise<Request> {
  const { db, p, f, mode } = s, html = mode === "html", assets = mode !== "content-only";
  const [run] = await db.select().from(workflowRuns).where(eq(workflowRuns.id, p.workflowRunId));
  const [definition] = await db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  const steps = (definition!.stepsJson as { id: string; [key: string]: unknown }[]).map(step => step.id !== f.qa.stepId ? step : {
    ...step, workProductSelectors: { produce: { type: "artifact", title: "report" } },
    toolArtifactContract: { role: "qa", schemaVersion: "workflow.qa-result.v1", inputStepId: "produce" } });
  await db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition!.id));
  const contract = { role: "qa", resultFileName: "qa.json", resultSchemaVersion: "workflow.qa-result.v1",
    resultAdapter: "generic", deploymentFiles: ["qa.mjs"], inputEnvelopeVersion: "workflow.artifact-input.v1",
    inputParams: html ? { html: "html", manifest: "manifest", out: "out" }
      : assets ? { content: "content", assetsDir: "assets", out: "out" } : { content: "content" },
    ...(html ? { bundleManifest: { fileName: manifestName, schemaVersion: "bundle.v1", ancillaryRoles: ["research"] } }
      : { assetDiscovery: mode === "content" ? ["/blocks/*/assetFile"] : [] }) };
  const requestId = randomUUID(), artifactExecution = freezeArtifactAttempt({ adapterConfig: { artifactContract: contract },
    step: steps.find(step => step.id === f.qa.stepId), executionGeneration: f.qa.executionGeneration, requestId });
  if (!artifactExecution) throw Error("frozen declaration required");
  const paths = buildMissionWorkProductPaths({ workProductRoot: s.root, missionId: p.missionId,
    workflowRunId: p.workflowRunId, stepId: f.qa.stepId });
  const output = path.join(paths.stepOutputDir!, "attempts", String(f.qa.executionGeneration), digest(requestId), randomUUID());
  const captured = new Map([...s.files].map(([name, bytes]) => [name === "source-notes.txt"
    ? "input/ancillary/research" : "input/" + name, bytes]));
  const outputRoot = await createArtifactDirectory(await captureArtifactRoot(s.root), path.relative(s.root, output),
    [...captured].map(([relative, bytes]) => ({ relative, bytes })), directories(captured, false));
  const main = s.files.get(mainName)!;
  const input: Input = { workProductId: s.productId, producer: s.producer, path: s.file,
    sha256: digest(main), byteSize: main.length, assetsRoot: !html && assets ? path.join(s.directory, "assets") : "",
    assetManifest: assetNames(mode).map(fileName => ({ fileName,
      sha256: digest(s.files.get("assets/" + fileName)!), byteSize: s.files.get("assets/" + fileName)!.length })),
    ...(html ? { mode: "html" as const, htmlManifest: { path: path.join(s.directory, manifestName),
      sha256: digest(s.files.get(manifestName)!), byteSize: s.files.get(manifestName)!.length },
      ancillaryManifest: [{ fileName: "research", sha256: digest(s.files.get("source-notes.txt")!),
        byteSize: s.files.get("source-notes.txt")!.length }] } : {}) };
  const request: Request = { artifactExecution, companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId,
    stepRunId: f.qa.id, stepId: f.qa.stepId, executionGeneration: f.qa.executionGeneration,
    retryCount: f.qa.retryCount, iterationIndex: f.qa.iterationIndex, requestId,
    root: outputRoot, outputRoot: outputRoot.path, outputRootHash: digest(JSON.stringify(outputRoot)), input };
  await db.update(workflowStepRuns).set({ status: "failed", lastDispatchRequestId: requestId,
    metadata: { artifactExecution, toolArtifactRequest: request } }).where(eq(workflowStepRuns.id, f.qa.id));
  return request;
}

/** Historical issuance and current request INPUT ONLY; not commit, selector or tool-QA delivery evidence. */
export async function makeCommitSource(db: Db, root: string, mode: CommitSourceMode = "html", legacy = false, quality = false) {
  const f = await seedQaCorrection(db, legacy ? "registered_legacy" : "identity", quality), p = f.preparation;
  const files = commitBuffers(mode, "old"), main = files.get(mainName)!;
  const provenance = p.sources[0]!.provenance;
  const { issueId: _issue, ...attempt } = p.producer;
  const producer: Input["producer"] = provenance.kind === "workflow_producer" ? { ...provenance.workflowProducer,
    sha256: digest(main), byteSize: main.length } : { schemaVersion: "workflow.work-product-producer.v1",
    companyId: p.companyId, missionId: p.missionId, workflowRunId: p.workflowRunId, ...attempt,
    heartbeatRunId: f.producerHeartbeatId };
  // A legacy fixture's syntactically valid producer is deliberately not registered as proof.
  if (!legacy) p.sources[0]!.provenance = { kind: "workflow_producer", workflowProducer: producer };
  const directory = await save(root, "missions/" + p.missionId + "/draft", files, mode !== "content-only");
  const file = path.join(directory, mainName);
  await db.update(companies).set({ workProductRoot: root }).where(eq(companies.id, p.companyId));
  await db.update(issueWorkProducts).set({ type: "artifact", title: "report", url: file,
    metadata: { path: file, ...(legacy ? {} : { workflowProducer: producer }) } }).where(eq(issueWorkProducts.id, f.productId));
  f.remediations.items[0]!.file = file;
  const v = p.authority.verdicts[0]!, [event] = await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.id, v.eventId));
  await db.update(workflowTransitionEvents).set({ payload: { ...event!.payload, remediations: f.remediations } }).where(eq(workflowTransitionEvents.id, v.eventId));
  v.remediationsHash = hashQaCorrectionPayload(f.remediations.items);
  const s: Omit<CommitSourceCase, "request"> = { db, root, mode, f, p, producer: producer,
    text: "old", productId: f.productId, directory, file, files, history: null, bundles: [{ directory, files }] };
  return { ...s, request: await declare(s) };
}

export async function makeCommitPrior(s: CommitSourceCase): Promise<CommitSourceCase> {
  const { db } = s, oldFiles = s.files, text = s.text === "old" ? "new" : "final";
  // Reuse the existing historical reader fixture, then bind it to independently known real bytes.
  const issued = await issueQaCorrectionFixture(db, s.f, s.p), revision = issued.applied.revisions[0]!;
  const files = commitBuffers(s.mode, text);
  const directory = await save(s.root, "missions/" + s.p.missionId + "/qa-corrections/" + s.p.correctionId
    + "/" + randomUUID() + "/" + s.productId, files, s.mode !== "content-only");
  revision.root = directory; revision.mainRelativePath = mainName;
  revision.bundleManifestRelativePath = s.mode === "html" ? manifestName : null;
  revision.assetsRelativeRoot = s.mode === "content-only" ? null : "assets";
  issued.measured.sources[0]!.files = commitFacts(oldFiles);
  revision.files = commitFacts(files).map(f => ({ ...f, beforeSha256: digest(oldFiles.get(f.relativePath)!) }));
  issued.applied.sourceMeasuredHash = hashQaCorrectionPayload(issued.measured);
  await db.update(workflowTransitionEvents).set({ payload: issued.measured }).where(eq(workflowTransitionEvents.id, issued.measuredId));
  await db.update(workflowTransitionEvents).set({ payload: issued.applied }).where(eq(workflowTransitionEvents.id, issued.appliedId));
  const file = path.join(directory, mainName);
  await db.update(issueWorkProducts).set({ type: "artifact", title: "report", url: null, externalId: file,
    metadata: { path: file, qaCorrection: { schemaVersion: "workflow.qa-correction.product.v1",
      appliedEventId: issued.appliedId, revisionId: revision.revisionId } } }).where(eq(issueWorkProducts.id, issued.workProductId));
  await readIssuedQaCorrection(db, issued.scope);
  s.f.remediations.items = [{ op: "string_replace", file, find: text, replace: text === "new" ? "final" : "finished" }];
  const verdict = await appendQaVerdict(db, s.f, "request_changes"), now = new Date();
  await db.update(heartbeatRuns).set({ createdAt: now }).where(eq(heartbeatRuns.id, verdict.heartbeatRunId));
  await db.update(workflowTransitionEvents).set({ createdAt: now }).where(eq(workflowTransitionEvents.id, verdict.eventId));
  const p = structuredClone(s.p);
  p.correctionId = randomUUID(); p.preparedAt = new Date().toISOString(); p.authority.verdicts = [verdict];
  p.sources = [{ productId: issued.workProductId, provenance: { kind: "prior_correction", appliedEventId: issued.appliedId } }];
  p.bindings[0]!.expectedProductId = issued.workProductId;
  const next = { ...s, p, text, productId: issued.workProductId, directory, file, files, history: issued,
    bundles: [...s.bundles, { directory, files }] };
  return { ...next, request: await declare(next) };
}

export async function commitFileState(s: CommitSourceCase) {
  const result = [];
  for (const bundle of s.bundles) for (const relative of [...bundle.files.keys(), ...directories(bundle.files, s.mode !== "content-only")]) {
    const file = path.resolve(bundle.directory, relative), st = await lstat(file);
    if (st.isSymbolicLink() || await realpath(file) !== file || (st.mode & 0o222)) throw Error("owned bundle is not immutable");
    const bytes = st.isFile() ? await readFile(file) : null;
    if (bytes && !bytes.equals(bundle.files.get(relative)!)) throw Error("fixture byte mismatch");
    result.push({ file, mode: st.mode, dev: st.dev, ino: st.ino, bytes });
  }
  return result;
}
export async function commitDbState(s: CommitSourceCase) {
  const { db } = s, id = s.p.companyId;
  return {
    events: await db.select().from(workflowTransitionEvents).where(eq(workflowTransitionEvents.companyId, id)).orderBy(asc(workflowTransitionEvents.id)),
    products: await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.companyId, id)).orderBy(asc(issueWorkProducts.id)),
    pins: await db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.companyId, id)).orderBy(asc(workflowStepOutputBindings.id)),
    usage: await db.select().from(qualityPolicyUsage).where(eq(qualityPolicyUsage.companyId, id)).orderBy(asc(qualityPolicyUsage.id)),
    groups: await db.select().from(qualityActionGroups).where(eq(qualityActionGroups.companyId, id)).orderBy(asc(qualityActionGroups.id)),
    receipts: await db.select().from(qualityEvidenceRefs).where(eq(qualityEvidenceRefs.companyId, id)).orderBy(asc(qualityEvidenceRefs.id)),
    wakes: await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, id)).orderBy(asc(agentWakeupRequests.id)),
    heartbeats: await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, id)).orderBy(asc(heartbeatRuns.id)),
    activities: await db.select().from(activityLog).where(eq(activityLog.companyId, id)).orderBy(asc(activityLog.id)),
  };
}
export async function changeCommitRequest(s: CommitSourceCase, mutate: (request: Request) => void) {
  const request = structuredClone(s.request); mutate(request);
  await s.db.update(workflowStepRuns).set({ metadata: { artifactExecution: s.request.artifactExecution,
    toolArtifactRequest: request } }).where(eq(workflowStepRuns.id, s.f.qa.id));
}
export async function changeCommitSelector(s: CommitSourceCase, selector: { type: string; title: string }) {
  const execution = await loadExecutionDefinition(s.db, s.p.workflowRunId, { requireHistorical: false });
  const [run] = await s.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
  await s.db.update(workflowDefinitions).set({ stepsJson: execution.steps.map(step => step.id !== s.f.qa.stepId
    ? step : { ...step, workProductSelectors: { produce: selector } }) }).where(eq(workflowDefinitions.id, run!.workflowId));
}

export async function hideCommitDeclaration(s: CommitSourceCase) {
  const [run] = await s.db.select().from(workflowRuns).where(eq(workflowRuns.id, s.p.workflowRunId));
  const [definition] = await s.db.select().from(workflowDefinitions).where(eq(workflowDefinitions.id, run!.workflowId));
  const [qa] = await s.db.select().from(workflowStepRuns).where(eq(workflowStepRuns.id, s.f.qa.id));
  const steps = (definition!.stepsJson as { id: string; [key: string]: unknown }[]).map(step => {
    if (step.id !== s.f.qa.stepId) return step;
    const { toolArtifactContract: _contract, workProductSelectors: _selectors, ...legacy } = step; return legacy;
  });
  await s.db.update(workflowDefinitions).set({ stepsJson: steps }).where(eq(workflowDefinitions.id, definition!.id));
  await s.db.update(workflowStepRuns).set({ metadata: {} }).where(eq(workflowStepRuns.id, s.f.qa.id));
  return async () => {
    await s.db.update(workflowDefinitions).set({ stepsJson: definition!.stepsJson }).where(eq(workflowDefinitions.id, definition!.id));
    await s.db.update(workflowStepRuns).set({ metadata: qa!.metadata }).where(eq(workflowStepRuns.id, s.f.qa.id));
  };
}
