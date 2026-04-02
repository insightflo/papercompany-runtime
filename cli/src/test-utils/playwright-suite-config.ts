import path from "node:path";

function normalizeSuiteName(suiteName: string): string {
  return String(suiteName ?? "")
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.?\//, "");
}

export function getPlaywrightSuiteConfigCandidates(suiteName: string): string[] {
  const normalizedSuiteName = normalizeSuiteName(suiteName);
  if (!normalizedSuiteName) {
    throw new Error("Suite name is required to resolve Playwright config.");
  }

  return [
    path.join("tests", normalizedSuiteName, "playwright.config.ts"),
    path.join("paperclip-orginal", "tests", normalizedSuiteName, "playwright.config.ts"),
  ];
}

export function resolvePlaywrightSuiteExecutionContext(input: {
  suiteName: string;
  cwd?: string;
  fileExists?: (candidate: string) => boolean;
}): {
  configPath: string;
  configArg: string;
  commandCwd: string;
} | null {
  const cwd = input.cwd ?? process.cwd();
  const fileExists = input.fileExists ?? (() => false);

  for (const candidate of getPlaywrightSuiteConfigCandidates(input.suiteName)) {
    const absoluteCandidate = path.resolve(cwd, candidate);
    if (!fileExists(absoluteCandidate)) continue;
    const candidateSegments = candidate.split(path.sep);
    const usesNestedWorkspace = candidateSegments[0] === "paperclip-orginal";
    const commandCwd = usesNestedWorkspace ? path.resolve(cwd, "paperclip-orginal") : cwd;

    return {
      configPath: absoluteCandidate,
      configArg: path.relative(commandCwd, absoluteCandidate),
      commandCwd,
    };
  }

  return null;
}

export function resolvePlaywrightSuiteConfigPath(input: {
  suiteName: string;
  cwd?: string;
  fileExists?: (candidate: string) => boolean;
}): string | null {
  return resolvePlaywrightSuiteExecutionContext(input)?.configPath ?? null;
}

export function normalizeForwardedPlaywrightArgs(args: string[]): string[] {
  if (!Array.isArray(args)) {
    return [];
  }
  return args[0] === "--" ? args.slice(1) : args;
}
