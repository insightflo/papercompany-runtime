import { chmod, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { expect, it } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, qualityActions, workflowStepRuns } from "@paperclipai/db";
import { deliverQualityIntent } from "../../services/quality/native-delivery.js";
import { applyCurrentOutputCorrection } from "../../services/quality/current-output.js";
import { createQaFileOwnerRuntime } from "../../services/workflow/control-flow/qa-remediation-runtime.js";
import { parseQaRemediationCompletion } from "../../services/workflow/control-flow/qa-remediation-completion-evidence.js";
import { QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3, parseQaRemediationPreparation } from "../../services/workflow/control-flow/qa-remediation-preparation-contract.js";
import { PYTHON } from "./qa-remediation-parent-death-harness.js";
import type { QualityTestDb } from "./quality-db.js";
import type { TestAction } from "./quality-current-output-trace-helpers.js";

type QualityCurrentOutputCaseContext = {
  owned: QualityTestDb;
  home: string;
  lockRoot: string;
  seedCurrentOutputAction: (fileCount?: number, verifyWriterBoundary?: boolean) => Promise<TestAction>;
  assertCurrentOutputSetup: (scenario: TestAction, actualsMustBeRunning?: boolean) => Promise<unknown>;
  useProcessVerifier: (scenario: TestAction) => Promise<void>;
  waitForObservedLockWait: (target: string, delivery: Promise<Awaited<ReturnType<typeof deliverQualityIntent>>>) => Promise<void>;
  preparationRows: (scenario: TestAction) => Promise<Array<{ payload: unknown }>>;
  completionRows: (scenario: TestAction) => Promise<Array<{ payload: unknown }>>;
  releaseSetupActuals: (scenario: TestAction) => Promise<unknown>;
  assertCurrentOutputSourceDrain: (scenario: TestAction, preparation: ReturnType<typeof parseQaRemediationPreparation>) => Promise<void>;
  useRows: (scenario: TestAction) => Promise<unknown[]>;
  qualityWakes: (scenario: TestAction) => Promise<unknown[]>;
  consumeAndSubmitOfficialPass: (scenario: TestAction, wakeupRequestId: string) => Promise<{ status: string }>;
};

export function registerQualityCurrentOutputFinalCases(getContext: () => QualityCurrentOutputCaseContext) {
  it("returns blocked on a real partial publication and reuses the already-published prefix", async () => {
    const { owned, home, lockRoot, seedCurrentOutputAction, assertCurrentOutputSetup, useProcessVerifier,
      waitForObservedLockWait, preparationRows, completionRows, releaseSetupActuals, assertCurrentOutputSourceDrain,
      useRows, qualityWakes, consumeAndSubmitOfficialPass } = getContext();
    const scenario = await seedCurrentOutputAction(2);
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    const secondFileDirectory = path.dirname(scenario.files[1]!.file);
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    const deliveryPromise = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    let leaveSecondDirectoryReadOnly = false;
    try {
      await waitForObservedLockWait(scenario.files[0]!.file, deliveryPromise);
      const preparations = await preparationRows(scenario);
      expect(preparations).toHaveLength(1);
      expect(parseQaRemediationPreparation(preparations[0]!.payload).schemaVersion)
        .toBe(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3);
      await releaseSetupActuals(scenario);
      // A real post-preflight filesystem refusal lets the native publisher durably apply only the prefix.
      await chmod(secondFileDirectory, 0o555);
    } finally {
      try {
        await releaseSetupActuals(scenario).catch(() => undefined);
        await holder.close();
        await deliveryPromise.catch(() => undefined);
        leaveSecondDirectoryReadOnly = true;
      } finally {
        if (!leaveSecondDirectoryReadOnly) await chmod(secondFileDirectory, 0o755).catch(() => undefined);
      }
    }
    const firstPublishedStat = await (async () => {
      try {
        expect(await deliveryPromise).toEqual({ status: "blocked", receiptId: null });
        expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.after);
        expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.before);
        const partial = await applyCurrentOutputCorrection(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
        expect(partial.remediation).toMatchObject({ outcome: "partial", reason: "publication_io_error" });
        expect(await completionRows(scenario)).toHaveLength(0);
        expect(await useRows(scenario)).toHaveLength(0);
        expect(await qualityWakes(scenario)).toHaveLength(0);
        return await stat(scenario.files[0]!.file);
      } finally {
        await chmod(secondFileDirectory, 0o755).catch(() => undefined);
      }
    })();

    expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.before);
    const retry = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(retry).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    const actual = await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(actual.status).toBe("succeeded");
    expect((await stat(scenario.files[0]!.file)).ino).toBe(firstPublishedStat.ino);
    expect(await readFile(scenario.files[1]!.file, "utf8")).toBe(scenario.files[1]!.after);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("holds when native ownership is unavailable and resumes from the same reservation", async () => {
    const { owned, home, lockRoot, seedCurrentOutputAction, assertCurrentOutputSetup, useProcessVerifier,
      waitForObservedLockWait, preparationRows, completionRows, releaseSetupActuals, assertCurrentOutputSourceDrain,
      useRows, qualityWakes, consumeAndSubmitOfficialPass } = getContext();
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = path.join(home, "missing-lock-root");
    const held = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    expect(held).toEqual({ status: "blocked", receiptId: null });
    expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.before);
    const preparations = await preparationRows(scenario);
    expect(preparations).toHaveLength(1);
    const preparation = parseQaRemediationPreparation(preparations[0]!.payload);
    expect(preparation.schemaVersion).toBe(QA_REMEDIATION_PREPARATION_SCHEMA_VERSION_V3);
    expect(preparation.qualityBinding.canonicalBinding).toEqual(scenario.binding);
    expect(await completionRows(scenario)).toHaveLength(0);
    expect(await useRows(scenario)).toHaveLength(0);
    expect(await qualityWakes(scenario)).toHaveLength(0);

    // Retain the real prepared reservation, then settle the original actuals
    // and reread the scoped G0 drain before the resume reaches native flock.
    await releaseSetupActuals(scenario);
    await assertCurrentOutputSourceDrain(scenario, preparation);
    await assertCurrentOutputSetup(scenario, false);

    process.env.PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT = lockRoot;
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    const resumedPromise = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    try {
      await waitForObservedLockWait(scenario.files[0]!.file, resumedPromise);
    } finally {
      await holder.close();
      await resumedPromise.catch(() => undefined);
    }
    const resumed = await resumedPromise;
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(resumed).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("blocks ordinary Quality delivery after completion-transaction uncertainty and recognizes the same bytes on reentry", async () => {
    const { owned, home, lockRoot, seedCurrentOutputAction, assertCurrentOutputSetup, useProcessVerifier,
      waitForObservedLockWait, preparationRows, completionRows, releaseSetupActuals, assertCurrentOutputSourceDrain,
      useRows, qualityWakes, consumeAndSubmitOfficialPass } = getContext();
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    await useProcessVerifier(scenario);
    const original = await readFile(scenario.files[0]!.file);
    const faultName = `c5_f1_completion_fault_${scenario.actionId.replaceAll("-", "")}`;
    await owned.db.execute(sql.raw(`CREATE FUNCTION ${faultName}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.event_type = 'qa_remediation_completed' AND NEW.workflow_run_id = '${scenario.seed.workflowRunId}'::uuid THEN RAISE EXCEPTION 'c5_f1_completion_fault'; END IF; RETURN NEW; END $$`));
    await owned.db.execute(sql.raw(`CREATE TRIGGER ${faultName} BEFORE INSERT ON workflow_transition_events FOR EACH ROW EXECUTE FUNCTION ${faultName}()`));
    let uncertain: Awaited<ReturnType<typeof deliverQualityIntent>> | undefined;
    const holder = await createQaFileOwnerRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: PYTHON! })
      .begin(scenario.files.map((file) => file.file));
    try {
      const delivery = deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
      await waitForObservedLockWait(scenario.files[0]!.file, delivery);
      expect(await preparationRows(scenario)).toHaveLength(1);
      await releaseSetupActuals(scenario);
      await holder.close();
      uncertain = await delivery;
    } finally {
      await releaseSetupActuals(scenario).catch(() => undefined);
      await holder.close();
      await owned.db.execute(sql.raw(`DROP TRIGGER IF EXISTS ${faultName} ON workflow_transition_events`));
      await owned.db.execute(sql.raw(`DROP FUNCTION IF EXISTS ${faultName}()`));
    }
    expect(uncertain!).toEqual({ status: "blocked", receiptId: null });
    expect(await readFile(scenario.files[0]!.file, "utf8")).toBe(scenario.files[0]!.after);
    expect(await completionRows(scenario)).toHaveLength(0);
    expect(await useRows(scenario)).toHaveLength(0);
    expect(await qualityWakes(scenario)).toHaveLength(0);
    const afterPublication = await stat(scenario.files[0]!.file);

    const resumed = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    const completion = parseQaRemediationCompletion((await completionRows(scenario))[0]!.payload);
    expect(completion.wakes).toHaveLength(1);
    expect(resumed).toEqual({ status: "accepted", receiptId: completion.wakes[0]!.wakeupRequestId });
    await consumeAndSubmitOfficialPass(scenario, completion.wakes[0]!.wakeupRequestId);
    expect(await readFile(scenario.files[0]!.file)).not.toEqual(original);
    expect((await stat(scenario.files[0]!.file)).ino).toBe(afterPublication.ino);
    expect(await preparationRows(scenario)).toHaveLength(1);
    expect(await completionRows(scenario)).toHaveLength(1);
    expect(await useRows(scenario)).toHaveLength(1);
    expect(await qualityWakes(scenario)).toHaveLength(0);
  }, 180_000);

  it("refuses delivery when the original source attempt changed after binding", async () => {
    const { owned, home, lockRoot, seedCurrentOutputAction, assertCurrentOutputSetup, useProcessVerifier,
      waitForObservedLockWait, preparationRows, completionRows, releaseSetupActuals, assertCurrentOutputSourceDrain,
      useRows, qualityWakes, consumeAndSubmitOfficialPass } = getContext();
    const scenario = await seedCurrentOutputAction();
    await assertCurrentOutputSetup(scenario);
    const exactBinding = scenario.binding;
    expect(exactBinding.stepRunId).toBe(scenario.seed.qaStepRunId);
    const [storedBinding] = await owned.db.select({ b: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, scenario.seeded.companyId), eq(qualityActions.id, scenario.actionId)));
    const initialQaActuals = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    await owned.db.update(workflowStepRuns).set({ executionGeneration: 2 })
      .where(eq(workflowStepRuns.id, scenario.seed.producerStepRunId));
    let result: Awaited<ReturnType<typeof deliverQualityIntent>>;
    try {
      result = await deliverQualityIntent(owned.db, { companyId: scenario.seeded.companyId, actionId: scenario.actionId });
    } finally {
      await releaseSetupActuals(scenario).catch(() => undefined);
    }
    expect(result).toEqual({ status: "blocked", receiptId: null });
    expect(await qualityWakes(scenario)).toHaveLength(0);
    const [after] = await owned.db.select({ b: qualityActions.canonicalBinding }).from(qualityActions)
      .where(and(eq(qualityActions.companyId, scenario.seeded.companyId), eq(qualityActions.id, scenario.actionId)));
    expect(after!.b).toEqual(storedBinding!.b);
    const afterQaActuals = await owned.db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, scenario.seeded.companyId), eq(heartbeatRuns.workflowStepRunId, scenario.seed.qaStepRunId),
    ));
    expect(afterQaActuals).toEqual(initialQaActuals);
  }, 120_000);
}
