#!/usr/bin/env node
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, chmod, mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const serverRoot = resolve(dirname(scriptPath), "..");
const sourceServerRoot = resolve(process.env.PAPERCLIP_QA_FILE_OWNER_SOURCE_SERVER_ROOT ?? serverRoot);
const controlFlowOut = join(serverRoot, "dist/services/workflow/control-flow");
const runtimeJs = join(controlFlowOut, "qa-remediation-runtime.js");
const ownerJs = join(controlFlowOut, "qa-remediation-file-owner.js");
const contractJs = join(controlFlowOut, "qa-remediation-contract.js");
const bundledHelper = join(controlFlowOut, "qa-remediation-file-owner.py");
const controlFlowSrc = join(sourceServerRoot, "src/services/workflow/control-flow");
const sourceFiles = [
  "qa-remediation-runtime.ts",
  "qa-remediation-file-owner.ts",
  "qa-remediation-contract.ts",
  "qa-remediation-file-owner.py",
];
const deadlineMs = 10_000;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function hashFile(filePath) {
  return sha256(await readFile(filePath));
}

async function sourceHashes() {
  return Object.fromEntries(await Promise.all(sourceFiles.map(async (name) => [name, await hashFile(join(controlFlowSrc, name))])));
}

async function findPython() {
  const explicit = process.env.PAPERCLIP_QA_FILE_OWNER_PYTHON ?? process.env.PYTHON;
  const candidates = explicit
    ? [explicit]
    : (process.env.PATH ?? "").split(delimiter).filter(Boolean).map((directory) => join(directory, "python3"));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try {
      const info = await stat(candidate);
      if (info.isFile() && (info.mode & 0o111) !== 0) {
        await access(candidate, constants.X_OK);
        return candidate;
      }
    } catch {
      // Continue through PATH candidates; no executable is installed or modified here.
    }
  }
  throw new Error("Set PAPERCLIP_QA_FILE_OWNER_PYTHON to an absolute executable Python path");
}

async function deadline(work, label) {
  let timer;
  try {
    return await Promise.race([
      work,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${deadlineMs}ms`)), deadlineMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function beginWithCleanup(runtime, targets, label) {
  const controller = new AbortController();
  const work = runtime.begin(targets, { signal: controller.signal });
  try {
    return await deadline(work, label);
  } catch (error) {
    controller.abort();
    await work.catch(() => undefined);
    throw error;
  }
}

function invariant(condition, message) {
  if (!condition) throw new Error(message);
}

async function main() {
  const initialCwd = process.cwd();
  const sourceBefore = await sourceHashes();
  const packageJson = JSON.parse(await readFile(join(serverRoot, "package.json"), "utf8"));
  const buildCommand = packageJson.scripts?.build;
  invariant(packageJson.type === "module", "server package is not configured as ESM");
  invariant(typeof buildCommand === "string" && buildCommand.includes("qa-remediation-file-owner.py")
    && buildCommand.includes("dist/services/workflow/control-flow"), "server build command does not package the sibling Python helper");

  const built = {
    runtimeJsSha256: await hashFile(runtimeJs),
    ownerJsSha256: await hashFile(ownerJs),
    contractJsSha256: await hashFile(contractJs),
    helperSha256: await hashFile(bundledHelper),
  };
  invariant(built.helperSha256 === sourceBefore["qa-remediation-file-owner.py"], "built helper bytes differ from the source helper");

  const runtimeModule = await import(pathToFileURL(runtimeJs).href);
  invariant(typeof runtimeModule.createQaFileOwnerRuntime === "function", "compiled runtime export is missing");
  const pythonCommand = await findPython();
  const scratchRoot = await realpath(await mkdtemp(join(tmpdir(), "c5-built-package-proof-")));
  let owner;
  let scratchRemoved = false;

  try {
    const lockRoot = join(scratchRoot, "lock-root");
    const elsewhere = join(scratchRoot, "different-working-directory");
    const targetDir = join(scratchRoot, "target");
    await mkdir(lockRoot, { mode: 0o700 });
    await chmod(lockRoot, 0o700);
    await mkdir(elsewhere, { mode: 0o700 });
    await mkdir(targetDir, { mode: 0o700 });

    const target = join(targetDir, "sample.txt");
    const before = Buffer.from("compiled package before\n");
    const after = Buffer.from("compiled package published by native helper\n");
    await writeFile(target, before, { mode: 0o600, flag: "wx" });

    const createRuntime = runtimeModule.createQaFileOwnerRuntime;
    const runtime = createRuntime({ qaFileOwnerLockRoot: lockRoot, qaFileOwnerPython: pythonCommand });
    let capability;
    try {
      process.chdir(elsewhere);
      capability = await deadline(runtime.capability, "built runtime capability");
    } finally {
      process.chdir(initialCwd);
    }
    invariant(capability.status === "configured", "built runtime did not report configured capability");
    invariant(capability.scope === "configuration-only", "built runtime capability scope changed");
    invariant(capability.lockRoot === lockRoot, "built runtime did not use the isolated configured lock root");
    invariant(capability.pythonCommand === pythonCommand, "built runtime did not use the configured Python executable");
    invariant(capability.helperPath === bundledHelper, "built runtime did not resolve the sibling helper from dist");

    owner = await beginWithCleanup(runtime, [target], "built runtime guard acquisition");
    invariant(JSON.stringify(owner.targets()) === JSON.stringify([target]), "acquired owner target set differs");
    const publication = await deadline(owner.publish([{
      target,
      beforeSha256: sha256(before),
      beforeSize: before.length,
      afterSha256: sha256(after),
      afterSize: after.length,
      bytesB64: after.toString("base64"),
    }]), "built runtime native publication");
    invariant(publication.outcome === "published", `native publication outcome was ${publication.outcome}`);
    invariant(publication.files.length === 1 && publication.files[0].status === "applied", "native publication did not apply exactly one target");
    invariant(publication.files[0].observedSha256 === sha256(after) && publication.files[0].observedSize === after.length,
      "native publication receipt does not match the requested bytes");
    invariant(sha256(await readFile(target)) === sha256(after), "target bytes do not match the native publication receipt");

    const closeExit = await deadline(owner.close(), "built runtime guard release");
    const observedExit = await deadline(owner.awaitExit(), "built helper process exit");
    owner = undefined;
    invariant(closeExit?.code === 0 && closeExit.signal === null, "helper close did not return exit 0");
    invariant(observedExit?.code === 0 && observedExit.signal === null, "helper exit observation did not match clean release");

    owner = await beginWithCleanup(runtime, [target], "guard reacquisition after release");
    invariant(JSON.stringify(owner.targets()) === JSON.stringify([target]), "reacquired owner target set differs");
    const reacquireCloseExit = await deadline(owner.close(), "reacquired guard release");
    const reacquireObservedExit = await deadline(owner.awaitExit(), "reacquired helper exit");
    owner = undefined;
    invariant(reacquireCloseExit?.code === 0 && reacquireCloseExit.signal === null, "reacquired helper close did not return exit 0");
    invariant(reacquireObservedExit?.code === 0 && reacquireObservedExit.signal === null, "reacquired helper did not exit cleanly");

    const failureTarget = join(targetDir, "unavailable.txt");
    const unchanged = Buffer.from("typed unavailable path leaves bytes unchanged\n");
    await writeFile(failureTarget, unchanged, { mode: 0o600, flag: "wx" });
    const unavailableRuntime = createRuntime({
      qaFileOwnerLockRoot: join(scratchRoot, "missing-lock-root"),
      qaFileOwnerPython: pythonCommand,
    });
    const unavailable = await deadline(unavailableRuntime.capability, "typed unavailable capability");
    invariant(unavailable.status === "unavailable", "missing lock root did not produce typed unavailable capability");
    invariant(unavailable.error.code === "qa_file_owner_unavailable" && unavailable.error.cause instanceof Error,
      "unavailable result lost its stable code or cause");
    let beginError;
    try {
      await deadline(unavailableRuntime.begin([failureTarget]), "typed unavailable begin");
    } catch (error) {
      beginError = error;
    }
    invariant(beginError === unavailable.error, "begin did not reject with the same typed unavailable error");
    invariant(sha256(await readFile(failureTarget)) === sha256(unchanged), "unavailable path changed the protected target");

    const sourceAfter = await sourceHashes();
    invariant(JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore), "production source hashes changed during proof");
    return {
      outcome: "PASS",
      proofScope: "standalone compiled server runtime and bundled native helper only",
      cwd: { initial: initialCwd, capabilityLookup: elsewhere },
      argv: process.argv,
      execArgv: process.execArgv,
      buildCommand,
      packageRoot: serverRoot,
      sourceServerRoot,
      packageType: packageJson.type,
      packageJsonSha256: await hashFile(join(serverRoot, "package.json")),
      tsconfigSha256: await hashFile(join(sourceServerRoot, "tsconfig.json")),
      sourceSha256: sourceBefore,
      builtSha256: built,
      config: { lockRoot, pythonCommand, helperPath: capability.helperPath },
      guard: {
        acquired: true,
        targets: [target],
        releaseExit: closeExit,
        observedExit,
        reacquiredAfterRelease: true,
        reacquireReleaseExit: reacquireCloseExit,
        reacquireObservedExit,
      },
      publication: { outcome: publication.outcome, files: publication.files, targetSha256: sha256(await readFile(target)) },
      unavailable: {
        status: unavailable.status,
        code: unavailable.error.code,
        causeName: unavailable.error.cause.name,
        beginRejectedSameError: beginError === unavailable.error,
        targetUnchanged: true,
      },
      productionSourceUnchanged: true,
      scratchRoot,
    };
  } finally {
    if (owner) {
      await deadline(owner.abort(), "owned helper cleanup");
      await deadline(owner.awaitExit(), "owned helper cleanup exit");
    }
    await rm(scratchRoot, { recursive: true, force: true });
    scratchRemoved = true;
    invariant(scratchRemoved, "temporary proof files were not removed");
  }
}

main().then((result) => {
  process.stdout.write(`${JSON.stringify({ ...result, scratchRemoved: true }, null, 2)}\n`);
}).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
