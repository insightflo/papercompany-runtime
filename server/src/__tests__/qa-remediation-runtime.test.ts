import { createHash } from "node:crypto";
import { constants, accessSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { delimiter, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createQaFileOwnerRuntime } from "../services/workflow/control-flow/qa-remediation-runtime.js";
import type {
  QaFileOwnerCapabilityResult,
  QaFileOwnerRuntimeSettings,
} from "../services/workflow/control-flow/qa-remediation-runtime.js";

const testDir = dirname(fileURLToPath(import.meta.url));
const serverDir = resolve(testDir, "../..");
const sourceDir = join(serverDir, "src/services/workflow/control-flow");
const pythonCommand = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON
  ?? process.env.PYTHON
  ?? process.env.PATH?.split(delimiter)
    .map((directory) => join(directory, "python3"))
    .find((candidate) => {
      try {
        accessSync(candidate, constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });
if (!pythonCommand) throw new Error("A Python 3 executable is required for native file-owner tests");

const SOURCE_FILES = [
  "qa-remediation-runtime.ts",
  "qa-remediation-file-owner.ts",
  "qa-remediation-contract.ts",
  "qa-remediation-file-owner.py",
] as const;
const DEADLINE_MS = 4_000;

type Runtime = ReturnType<typeof createQaFileOwnerRuntime>;
type Owner = Awaited<ReturnType<Runtime["begin"]>>;
type BeginOptions = NonNullable<Parameters<Runtime["begin"]>[1]>;
interface TrackedBegin {
  readonly controller: AbortController;
  promise: Promise<Owner>;
  owner?: Owner;
}

let scratchRoot = "";
let packagedDir = "";
let packagedRuntimePath = "";
let packagedHelperPath = "";
const trackedBegins = new Set<TrackedBegin>();
const startedOwners = new Set<Owner>();

function settings(lockRoot: string, python = pythonCommand): QaFileOwnerRuntimeSettings {
  return { qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: python };
}

function hash(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function deadline<T>(work: Promise<T>, label: string, ms = DEADLINE_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms deadline`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function beginTracked(runtime: Runtime, targets: readonly string[], options: BeginOptions = {}): TrackedBegin {
  const record: TrackedBegin = {
    controller: new AbortController(),
    promise: Promise.resolve(null as unknown as Owner),
  };
  trackedBegins.add(record);
  record.promise = Promise.resolve().then(() => runtime.begin(targets, {
    ...options,
    signal: record.controller.signal,
  })).then((owner) => {
    record.owner = owner;
    startedOwners.add(owner);
    return owner;
  });
  return record;
}

async function makeDirectory(name: string): Promise<string> {
  const directory = join(scratchRoot, name);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  return directory;
}

function unavailable(result: QaFileOwnerCapabilityResult) {
  expect(result.status).toBe("unavailable");
  if (result.status !== "unavailable") throw new Error("expected unavailable capability");
  expect(result.error.code).toBe("qa_file_owner_unavailable");
  expect(result.error.cause).toBeInstanceOf(Error);
  return result.error;
}

async function publishItem(target: string, before: Buffer, after: Buffer) {
  return {
    target,
    beforeSha256: hash(before),
    beforeSize: before.length,
    afterSha256: hash(after),
    afterSize: after.length,
    bytesB64: after.toString("base64"),
  };
}

async function closeAndObserve(owner: Owner): Promise<void> {
  await deadline(owner.close(), "helper close");
  expect(await deadline(owner.awaitExit(), "helper exit")).toEqual({ code: 0, signal: null });
}

async function importPackagedSourceRuntime(): Promise<typeof createQaFileOwnerRuntime> {
  const loaded = await import(packagedRuntimePath) as typeof import("../services/workflow/control-flow/qa-remediation-runtime.js");
  return loaded.createQaFileOwnerRuntime;
}

describe.sequential("qa remediation file-owner runtime", () => {
  beforeAll(async () => {
    scratchRoot = await realpath(await mkdtemp(join(tmpdir(), "c5-a-runtime-test-")));
    packagedDir = join(scratchRoot, "package/services/workflow/control-flow");
    await mkdir(packagedDir, { recursive: true, mode: 0o700 });
    for (const file of SOURCE_FILES) await copyFile(join(sourceDir, file), join(packagedDir, file));
    packagedRuntimePath = join(packagedDir, "qa-remediation-runtime.ts");
    packagedHelperPath = join(packagedDir, "qa-remediation-file-owner.py");
  });

  afterAll(async () => {
    const cleanupErrors: unknown[] = [];
    for (const begin of trackedBegins) begin.controller.abort();
    for (const begin of trackedBegins) {
      try {
        await deadline(begin.promise.then(() => undefined, () => undefined), "tracked begin cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    for (const owner of startedOwners) {
      try {
        await deadline(owner.abort(), "owned helper cleanup");
        await deadline(owner.awaitExit(), "owned helper exit after cleanup");
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    if (cleanupErrors.length > 0) throw new AggregateError(cleanupErrors, "owned helper cleanup did not settle");
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true });
  });

  it("copies the exact helper and resolves the sibling from a different cwd", async () => {
    const sourceBytes = await readFile(join(sourceDir, "qa-remediation-file-owner.py"));
    const packagedBytes = await readFile(packagedHelperPath);
    expect(hash(packagedBytes)).toBe(hash(sourceBytes));

    const lockRoot = await makeDirectory("cwd-lock-root");
    const elsewhere = await makeDirectory("unrelated-cwd");
    const previousCwd = process.cwd();
    const createRuntime = await importPackagedSourceRuntime();
    let capability: QaFileOwnerCapabilityResult;
    try {
      process.chdir(elsewhere);
      capability = await createRuntime(settings(lockRoot)).capability;
    } finally {
      process.chdir(previousCwd);
    }
    if (capability.status !== "configured") throw capability.error;
    expect(capability.scope).toBe("configuration-only");
    expect(capability.helperPath).toBe(packagedHelperPath);
  });

  it("returns typed unavailable with its cause and leaves targets unchanged", async () => {
    const validRoot = await makeDirectory("failure-valid-root");
    const aliasRoot = join(scratchRoot, "failure-root-alias");
    await symlink(validRoot, aliasRoot, "dir");
    const unsafeRoot = await makeDirectory("failure-unsafe-root");
    await chmod(unsafeRoot, 0o755);
    const nonExecutablePython = join(scratchRoot, "python-not-executable");
    await writeFile(nonExecutablePython, "not an executable\n", { mode: 0o600 });

    const cases: Array<{ name: string; config: QaFileOwnerRuntimeSettings }> = [
      { name: "missing lock directory", config: settings(join(scratchRoot, "no-lock-root")) },
      { name: "relative lock directory", config: settings("relative-lock-root") },
      { name: "symlink lock directory", config: settings(aliasRoot) },
      { name: "unsafe lock directory", config: settings(unsafeRoot) },
      { name: "missing Python", config: settings(validRoot, join(scratchRoot, "no-python")) },
      { name: "non-executable Python", config: settings(validRoot, nonExecutablePython) },
    ];
    const createRuntime = await importPackagedSourceRuntime();
    for (const [index, testCase] of cases.entries()) {
      const targetDir = await makeDirectory(`failure-target-${index}`);
      const target = join(targetDir, "protected.txt");
      const before = Buffer.from(`unchanged-${testCase.name}\n`);
      await writeFile(target, before, { mode: 0o600 });
      const runtime = createRuntime(testCase.config);
      const capability = await deadline(runtime.capability, `${testCase.name} capability`);
      const error = unavailable(capability);
      const begin = beginTracked(runtime, [target]);
      await expect(begin.promise).rejects.toBe(error);
      expect(await readFile(target)).toEqual(before);
    }
  });

  it("refuses a missing helper in the owned package copy without touching targets", async () => {
    const targetDir = await makeDirectory("missing-helper-target");
    const lockRoot = await makeDirectory("missing-helper-lock-root");
    const target = join(targetDir, "protected.txt");
    const before = Buffer.from("unchanged while helper is missing\n");
    await writeFile(target, before, { mode: 0o600 });
    await unlink(packagedHelperPath);
    try {
      const runtime = (await importPackagedSourceRuntime())(settings(lockRoot));
      const capability = await deadline(runtime.capability, "missing-helper capability");
      const error = unavailable(capability);
      expect(String(error.cause)).toContain("qa-remediation-file-owner.py");
      const begin = beginTracked(runtime, [target]);
      await expect(begin.promise).rejects.toBe(error);
      expect(await readFile(target)).toEqual(before);
    } finally {
      await copyFile(join(sourceDir, "qa-remediation-file-owner.py"), packagedHelperPath);
    }
  });

  it("ignores extraneous JavaScript options and publishes only the positional target", async () => {
    const lockRoot = await makeDirectory("options-lock-root");
    const alternateRoot = await makeDirectory("options-alternate-root");
    const targetDir = await makeDirectory("options-targets");
    const target = join(targetDir, "authorized.txt");
    const decoy = join(targetDir, "decoy.txt");
    const before = Buffer.from("before\n");
    const after = Buffer.from("authorized after\n");
    const decoyBefore = Buffer.from("decoy stays\n");
    await writeFile(target, before, { mode: 0o600 });
    await writeFile(decoy, decoyBefore, { mode: 0o600 });

    const runtime = (await importPackagedSourceRuntime())(settings(lockRoot));
    const extra = {
      lockRoot: alternateRoot,
      pythonCommand: join(scratchRoot, "wrong-python"),
      helperPath: join(scratchRoot, "wrong-helper.py"),
      targets: [decoy],
    } as unknown as BeginOptions;
    const begun = beginTracked(runtime, [target], extra);
    const owner = await deadline(begun.promise, "configured helper begin");
    expect(owner.targets()).toEqual([target]);
    const result = await deadline(owner.publish([await publishItem(target, before, after)]), "configured publish");
    expect(result.outcome).toBe("published");
    expect(await readFile(target)).toEqual(after);
    expect(await readFile(decoy)).toEqual(decoyBefore);
    const guardName = `c5-${hash(Buffer.from(target))}.guard`;
    await expect(readFile(join(lockRoot, guardName))).resolves.toBeDefined();
    await expect(readFile(join(alternateRoot, guardName))).rejects.toMatchObject({ code: "ENOENT" });
    await closeAndObserve(owner);
  });

  it("serializes independent native helpers through publish and close", async () => {
    const lockRoot = await makeDirectory("contention-lock-root");
    const targetDir = await makeDirectory("contention-targets");
    const target = join(targetDir, "shared.txt");
    const before = Buffer.from("baseline\n");
    const firstBytes = Buffer.from("first authorized generation\n");
    const secondBytes = Buffer.from("latest authorized generation\n");
    await writeFile(target, before, { mode: 0o600 });
    const createRuntime = await importPackagedSourceRuntime();
    const runtime = createRuntime(settings(lockRoot));

    const firstBegin = beginTracked(runtime, [target]);
    const first = await deadline(firstBegin.promise, "first native helper begin");
    const firstResult = await deadline(first.publish([await publishItem(target, before, firstBytes)]), "first native publish");
    expect(firstResult.outcome).toBe("published");
    expect(await readFile(target)).toEqual(firstBytes);

    let reportLockWait!: (event: { readonly type: "lock_wait"; readonly target: string }) => void;
    const lockWait = new Promise<{ readonly type: "lock_wait"; readonly target: string }>((resolveEvent) => {
      reportLockWait = resolveEvent;
    });
    const secondBegin = beginTracked(runtime, [target], { onEvent: reportLockWait });
    const event = await deadline(lockWait, "positive native lock_wait event");
    expect(event).toEqual({ type: "lock_wait", target });

    await closeAndObserve(first);
    expect(await deadline(first.awaitExit(), "first helper observed exit")).toEqual({ code: 0, signal: null });
    const second = await deadline(secondBegin.promise, "second helper after first exit");
    const secondResult = await deadline(second.publish([await publishItem(target, firstBytes, secondBytes)]), "second native publish");
    expect(secondResult.outcome).toBe("published");
    expect(await readFile(target)).toEqual(secondBytes);
    await closeAndObserve(second);
  });
});
