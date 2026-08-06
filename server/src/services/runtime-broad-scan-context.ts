/**
 * @fileoverview Shared context readers for the runtime broad-scan guard and hook.
 *
 * Both `runtime-broad-scan-tool-guard.ts` (the legacy guard, now a thin wrapper)
 * and `runtime-broad-scan-hook.ts` (the intercept+synthesize hook) build the same
 * evaluation context from a run's heartbeat context snapshot. Extracting these
 * readers keeps the two consumers in sync and avoids drift.
 *
 * @module server/services/runtime-broad-scan-context
 */

import { parseObject } from "../adapters/utils.js";
import {
  missionSearchScopesAllowRepo,
  normalizeMissionSearchScopes,
  type MissionSearchScope,
} from "./runtime-search-scopes.js";

export function readAllowedFileViewPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => parseObject(entry)?.relativePath)
    .filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

export interface RuntimeBroadScanPaths {
  declared: boolean;
  workingDirectory: string | null;
  outputDirectory: string | null;
  dependencyFiles: string[];
  dependencyDirectories: string[];
  allowedSearchScopes: MissionSearchScope[];
  broadScanRepoAllowed: boolean;
}

export function readRuntimeSearchPaths(value: unknown): RuntimeBroadScanPaths {
  const permissions = parseObject(value);
  const workingDirectory = permissions?.workingDirectory;
  const outputDirectory = permissions?.outputDirectory;
  const dependencyFiles = Array.isArray(permissions?.dependencyFiles)
    ? permissions.dependencyFiles.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    )
    : [];
  const dependencyDirectories = Array.isArray(permissions?.dependencyDirectories)
    ? permissions.dependencyDirectories.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    )
    : [];
  const allowedSearchScopes = normalizeMissionSearchScopes(permissions?.allowedSearchScopes);
  const broadScanRepoAllowed = typeof permissions?.broadScanRepoAllowed === "boolean"
    ? permissions.broadScanRepoAllowed
    : missionSearchScopesAllowRepo(allowedSearchScopes);
  return {
    declared: permissions?.version === 1,
    workingDirectory: typeof workingDirectory === "string" && workingDirectory.trim().length > 0
      ? workingDirectory
      : null,
    outputDirectory: typeof outputDirectory === "string" && outputDirectory.trim().length > 0
      ? outputDirectory
      : null,
    dependencyFiles,
    dependencyDirectories,
    allowedSearchScopes,
    broadScanRepoAllowed,
  };
}

export function containsWorkingDirectoryChange(command: string): boolean {
  return /(^|[\s;(])(cd|pushd|popd)\s/i.test(command);
}
