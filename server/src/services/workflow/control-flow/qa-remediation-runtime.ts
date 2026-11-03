import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { Config } from "../../../config.js";
import {
  QaRemediationFileOwner,
  QaRemediationFileOwnerError,
  type FileOwnerBeginInput,
} from "./qa-remediation-file-owner.js";

export type QaFileOwnerRuntimeSettings = Pick<Config, "qaFileOwnerLockRoot" | "qaFileOwnerPython">;

export interface QaFileOwnerConfiguredCapability {
  readonly status: "configured";
  readonly scope: "configuration-only";
  readonly lockRoot: string;
  readonly pythonCommand: string;
  readonly helperPath: string;
}

export class QaFileOwnerUnavailableError extends Error {
  readonly code = "qa_file_owner_unavailable";
  readonly cause: unknown;

  constructor(message: string, cause: unknown) {
    super(message);
    this.name = "QaFileOwnerUnavailableError";
    this.cause = cause;
  }
}

export type QaFileOwnerCapabilityResult =
  | QaFileOwnerConfiguredCapability
  | { readonly status: "unavailable"; readonly error: QaFileOwnerUnavailableError };

export type QaFileOwnerBeginOptions = Pick<FileOwnerBeginInput, "onEvent" | "signal">;

export interface QaFileOwnerRuntime {
  readonly capability: Promise<QaFileOwnerCapabilityResult>;
  begin(
    targets: readonly string[],
    options?: QaFileOwnerBeginOptions,
  ): Promise<QaRemediationFileOwner>;
}

function unavailable(message: string, cause: unknown): QaFileOwnerCapabilityResult {
  return {
    status: "unavailable",
    error: new QaFileOwnerUnavailableError(message, cause),
  };
}

async function validateLockRoot(configuredPath: string | undefined): Promise<string> {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT is required");
  }
  if (!isAbsolute(configuredPath) || configuredPath.includes("\0")) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT must be an absolute canonical path");
  }

  const canonicalPath = await realpath(configuredPath);
  if (canonicalPath !== configuredPath) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT must use its exact canonical spelling");
  }

  const directory = await stat(configuredPath);
  if (!directory.isDirectory()) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT must name an existing directory");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid === undefined || directory.uid !== uid || (directory.mode & 0o077) !== 0) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_LOCK_ROOT must be owned by this user and private");
  }
  await access(configuredPath, constants.R_OK | constants.W_OK | constants.X_OK);
  return configuredPath;
}

async function validatePythonCommand(configuredPath: string | undefined): Promise<string> {
  if (typeof configuredPath !== "string" || configuredPath.length === 0) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_PYTHON is required");
  }
  if (!isAbsolute(configuredPath) || configuredPath.includes("\0")) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_PYTHON must be an absolute executable path");
  }
  const executable = await stat(configuredPath);
  if (!executable.isFile() || (executable.mode & 0o111) === 0) {
    throw new Error("PAPERCLIP_QA_FILE_OWNER_PYTHON must name an executable file");
  }
  await access(configuredPath, constants.X_OK);
  return configuredPath;
}

async function validateBundledHelper(): Promise<string> {
  const helperPath = fileURLToPath(new URL("./qa-remediation-file-owner.py", import.meta.url));
  const helper = await stat(helperPath);
  if (!helper.isFile()) throw new Error("bundled QA file-owner helper is not a regular file");
  await access(helperPath, constants.R_OK);
  return helperPath;
}

async function inspectConfiguration(settings: QaFileOwnerRuntimeSettings): Promise<QaFileOwnerCapabilityResult> {
  try {
    const [lockRoot, pythonCommand, helperPath] = await Promise.all([
      validateLockRoot(settings?.qaFileOwnerLockRoot),
      validatePythonCommand(settings?.qaFileOwnerPython),
      validateBundledHelper(),
    ]);
    return { status: "configured", scope: "configuration-only", lockRoot, pythonCommand, helperPath };
  } catch (cause) {
    return unavailable("QA file-owner configuration is unavailable", cause);
  }
}

/** Resolves explicit paths only; it does not probe or claim native lock or filesystem capability. */
export function createQaFileOwnerRuntime(settings: QaFileOwnerRuntimeSettings): QaFileOwnerRuntime {
  const capability = inspectConfiguration(settings);
  return {
    capability,
    async begin(targets, options = {}) {
      const configured = await capability;
      if (configured.status === "unavailable") throw configured.error;
      try {
        return await QaRemediationFileOwner.begin({
          lockRoot: configured.lockRoot,
          pythonCommand: configured.pythonCommand,
          helperPath: configured.helperPath,
          targets,
          onEvent: options.onEvent,
          signal: options.signal,
        });
      } catch (cause) {
        if (cause instanceof QaRemediationFileOwnerError
          && (cause.code === "aborted" || cause.code === "bad_begin")) {
          throw cause;
        }
        throw new QaFileOwnerUnavailableError("QA file-owner helper could not begin", cause);
      }
    },
  };
}
