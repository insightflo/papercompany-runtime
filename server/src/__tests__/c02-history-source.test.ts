import path from "node:path";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agentWakeupRequests, heartbeatRuns, issues, issueWorkProducts, workflowDefinitions,
  workflowRuns, workflowStepOutputBindings, workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import { QaCorrectionReadError } from "../services/workflow/control-flow/qa-correction-authority.js";
import { readIssuedQaCorrection } from "../services/workflow/control-flow/qa-correction-reader.js";
import { beginQaCorrection } from "../services/workflow/control-flow/qa-correction-prepare.js";
import { measureQaCorrectionSources } from "../services/workflow/control-flow/qa-correction-measure.js";
import { storeQaCorrection } from "../services/workflow/control-flow/qa-correction-storage.js";
import { commitQaCorrection } from "../services/workflow/control-flow/qa-correction-commit.js";
import { createCommitSourceHarness, hideCommitDeclaration, makeCommitSource } from "./qa-correction-commit-fixture.js";
import { createClaimFixture, issueFollowingC02 } from "./helpers/c02-claim-race-fixture.js";
import { appendQaVerdict } from "./helpers/qa-correction-fixture.js";

// C02/C03/C12: the unchanged baseline accepts the root/unselected branch and refuses the selected bad edge.
// Use actual files, fresh QA authorities and the real C03 writers; no manufactured issuance records.
let owned: Awaited<ReturnType<typeof createCommitSourceHarness>>;
let fixtures: ReturnType<typeof createClaimFixture>;
const track = (db: Db) => db;
beforeAll(async () => {
  owned = await createCommitSourceHarness();
  fixtures = createClaimFixture(owned, track, [], []);
}, 120000);
afterAll(async () => { await owned?.close(); }, 120000);

it("preserves intermediate binding refusal during real following source observation", async () => {
  const first = await fixtures.world(false, false), second = await issueFollowingC02(first.c, 1);
  const third = await issueFollowingC02(second, 2), binding = second.s.p.bindings[0]!;
  expect((await readIssuedQaCorrection(owned.db, third.ref)).preparation.correctionId).toBe(third.s.p.correctionId);
  const [before] = await owned.db.select().from(workflowStepOutputBindings).where(eq(workflowStepOutputBindings.id, binding.bindingId));
  expect(before!.workProductId).toBe(second.applied.revisions[0]!.workProductId);
  // Only an intermediate QA binding is moved backwards, with no genuine same-binding successor.
  await owned.db.update(workflowStepOutputBindings).set({ workProductId: first.c.applied.revisions[0]!.workProductId })
    .where(eq(workflowStepOutputBindings.id, binding.bindingId));
  // Existing public reader checks its requested root binding, not each ancestor binding.
  expect((await readIssuedQaCorrection(owned.db, third.ref)).preparation.correctionId).toBe(third.s.p.correctionId);
  const following = issueFollowingC02(third, 3);
  await expect(following).rejects.toBeInstanceOf(QaCorrectionReadError);
  await expect(following).rejects.toMatchObject({ message: "qa_correction_binding", reason: "binding" });
  const applied = await owned.db.select().from(workflowTransitionEvents).where(and(
    eq(workflowTransitionEvents.companyId, third.ref.companyId),
    eq(workflowTransitionEvents.workflowRunId, third.ref.workflowRunId),
    eq(workflowTransitionEvents.eventType, "qa_remediation_applied"),
    sql`${workflowTransitionEvents.payload}->>'schemaVersion' = 'workflow.qa-correction.applied.v1'`));
  expect(applied).toHaveLength(3);
  expect(applied.map(row => row.id).sort()).toEqual([
    first.c.ref.appliedEventId, second.ref.appliedEventId, third.ref.appliedEventId,
  ].sort());
}, 60000);

it("preserves the unselected sibling's binding-successor exclusion", async () => {
  type Case = Awaited<ReturnType<typeof issueFollowingC02>>;
  type Source = import("../services/workflow/control-flow/qa-correction-contract.js")
    .QaCorrectionPreparation["sources"][number];
  type Input = Source & { file: string };
  type Revision = Case["applied"]["revisions"][number];

  const seed = await makeCommitSource(owned.db, owned.root, "content-only", true);
  await hideCommitDeclaration(seed);
  const peer = track(owned.connect());

  // Fresh QA and a fresh binding for every custom issuance, including M.
  async function issueMany(
    s: Case["s"], inputs: Input[], token: string,
  ): Promise<Case> {
    if (!inputs.length || s.mode !== "content-only") throw Error("inputs required");
    const p = structuredClone(s.p);
    p.correctionId = randomUUID();
    p.sources = inputs.map(({ file: _file, ...source }) => source);
    p.bindings = [];
    const held = await Promise.all(inputs.map(async input => {
      const bytes = await readFile(input.file);
      const title: unknown = JSON.parse(bytes.toString("utf8")).title;
      if (typeof title !== "string") throw Error("actual ContentV1 title required");
      return { ...input, bytes, title };
    }));
    const remediations = { items: held.map((input, index) => ({
      op: "string_replace" as const, file: input.file,
      find: input.title, replace: token + "-" + index,
    })) };
    const [origin] = await peer.select().from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, s.f.verdictHeartbeatId));
    const [run] = await peer.select().from(workflowRuns)
      .where(eq(workflowRuns.id, p.workflowRunId));
    if (!origin || !run) throw Error("actual origin/run required");
    const [definition] = await peer.select().from(workflowDefinitions)
      .where(eq(workflowDefinitions.id, run.workflowId));
    if (!definition) throw Error("actual definition required");
    const stepId = "qa-join-" + randomUUID();
    await peer.update(workflowDefinitions).set({
      stepsJson: [...definition.stepsJson, {
        id: stepId, name: token, type: "agent", agentId: origin.agentId,
        dependencies: [p.producer.stepId],
        workProductSelectors: {
          [p.producer.stepId]: { type: "artifact", title: "report" },
        },
      }],
    }).where(eq(workflowDefinitions.id, definition.id));
    const [issue] = await peer.insert(issues).values({
      companyId: p.companyId, missionId: p.missionId, title: "[QA] " + token,
      status: "todo", assigneeAgentId: origin.agentId,
      originKind: "workflow_execution", originRunId: p.workflowRunId,
    }).returning();
    if (!issue) throw Error("QA issue required");
    const [qa] = await peer.insert(workflowStepRuns).values({
      workflowRunId: p.workflowRunId, stepId, issueId: issue.id, status: "failed",
    }).returning();
    if (!qa) throw Error("QA step required");
    const [binding] = await peer.insert(workflowStepOutputBindings).values({
      companyId: p.companyId, workflowRunId: p.workflowRunId,
      consumerStepRunId: qa.id, referencedStepId: p.producer.stepId,
      sourceExecutionGeneration: p.producer.executionGeneration,
      workProductId: inputs[0]!.productId,
    }).returning();
    if (!binding) throw Error("fresh binding required");
    const f = { ...s.f, qa, bindingId: binding.id, remediations, preparation: p };
    const verdict = await appendQaVerdict(peer, f, "request_changes", remediations);
    const now = new Date();
    const [heartbeat] = await peer.update(heartbeatRuns).set({ createdAt: now })
      .where(eq(heartbeatRuns.id, verdict.heartbeatRunId)).returning();
    if (!heartbeat?.wakeupRequestId) throw Error("actual verdict wake required");
    await peer.update(workflowTransitionEvents).set({ createdAt: now })
      .where(eq(workflowTransitionEvents.id, verdict.eventId));
    await peer.update(agentWakeupRequests).set({ status: "completed" })
      .where(eq(agentWakeupRequests.id, heartbeat.wakeupRequestId));
    p.preparedAt = now.toISOString();
    p.authority = { kind: "workflow_qa", verdicts: [verdict], toolEvidence: null };
    p.bindings = [{
      bindingId: binding.id, consumer: verdict.qa,
      referencedStepId: p.producer.stepId, expectedProductId: inputs[0]!.productId,
    }];
    const prepared = await beginQaCorrection(s.db, p);
    if (prepared.status !== "prepared") throw Error("begin: " + prepared.status);
    const measured = await measureQaCorrectionSources(s.db, {
      preparationEventId: prepared.preparationEventId,
      preparationHash: prepared.preparationHash,
    });
    const stored = await storeQaCorrection(s.db, measured);
    const committed = await commitQaCorrection(s.db, stored);
    if (committed.status !== "committed") throw Error("commit: " + committed.status);
    const scope = {
      companyId: p.companyId, workflowRunId: p.workflowRunId,
      appliedEventId: committed.appliedEventId,
    };
    const issued = await readIssuedQaCorrection(peer, scope);
    const followup = issued.followups[0]!;
    const [appliedRow] = await peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, scope.appliedEventId));
    const [followupRow] = await peer.select().from(workflowTransitionEvents)
      .where(eq(workflowTransitionEvents.id, issued.applied.followupEventIds[0]!));
    if (!appliedRow || !followupRow) throw Error("committed rows required");
    const first = held[0]!;
    return {
      s: {
        ...s, p: prepared.preparation,
        f: { ...f, preparation: prepared.preparation,
          verdictHeartbeatId: heartbeat.id, verdictWakeId: heartbeat.wakeupRequestId },
        productId: first.productId, file: first.file,
        directory: path.dirname(first.file), text: first.title,
        files: new Map([[path.basename(first.file), first.bytes]]),
      },
      peer, stored, appliedRow, applied: issued.applied, followupRow, followup,
      ref: { ...scope, requestId: followup.requestId },
    };
  }
  const priorInput = (c: Case, r: Revision): Input => ({
    productId: r.workProductId,
    provenance: { kind: "prior_correction", appliedEventId: c.ref.appliedEventId },
    file: path.join(r.root, r.mainRelativePath),
  });

  // Controlled ordinary registered input, not a fabricated correction record.
  const secondFile = path.join(owned.root, "sibling-input", seed.p.companyId, "report.html");
  await mkdir(path.dirname(secondFile), { recursive: true });
  await writeFile(secondFile, await readFile(seed.file));
  const [second] = await peer.insert(issueWorkProducts).values({
    companyId: seed.p.companyId, issueId: seed.p.producer.issueId,
    type: "artifact", provider: "local_file", title: "report", status: "active",
    url: secondFile, metadata: { path: secondFile },
  }).returning();
  if (!second) throw Error("registered second input required");
  const a = await issueMany(seed, [
    { ...seed.p.sources[0]!, file: seed.file },
    { productId: second.id, provenance: { kind: "registered_legacy" }, file: secondFile },
  ], "join-A");
  expect(a.applied.revisions).toHaveLength(2);
  const x = await issueFollowingC02(a, 101);
  const xSource = x.s.p.sources[0]!.productId;
  const otherA = a.applied.revisions.find(r => r.workProductId !== xSource)!;
  const y = await issueMany(a.s, [priorInput(a, otherA)], "join-Y");
  const m = await issueMany(x.s, [
    priorInput(x, x.applied.revisions[0]!),
    priorInput(y, y.applied.revisions[0]!),
  ], "join-M");
  expect(m.applied.revisions).toHaveLength(2);
  const selected = m.applied.revisions[0]!;
  const branches = [x, y];
  const skipped = branches.find(c =>
    c.applied.revisions[0]!.workProductId !== selected.sourceProductId)!;
  const skippedBinding = skipped.s.p.bindings[0]!;
  expect(m.s.p.bindings.some(b => b.bindingId === skippedBinding.bindingId)).toBe(false);
  const backToA = skipped.s.p.sources[0]!.productId;
  expect(a.applied.revisions.some(r => r.workProductId === backToA)).toBe(true);
  await expect(readIssuedQaCorrection(peer, skipped.ref)).resolves.toBeDefined();

  await peer.update(workflowStepOutputBindings).set({ workProductId: backToA })
    .where(eq(workflowStepOutputBindings.id, skippedBinding.bindingId));
  await expect(readIssuedQaCorrection(peer, skipped.ref)).rejects.toMatchObject({
    message: "qa_correction_binding", reason: "binding",
  });
  const next = await issueFollowingC02(m, 102);
  expect(next.s.p.sources).toEqual([{
    productId: selected.workProductId,
    provenance: { kind: "prior_correction", appliedEventId: m.ref.appliedEventId },
  }]);
  expect(next.applied.revisions[0]!.sourceProductId).toBe(selected.workProductId);
}, 120000);
