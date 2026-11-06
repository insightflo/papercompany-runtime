import fs from "node:fs/promises";
import path from "node:path";
import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";
import { resolveManagedProjectWorkspaceDir } from "../home-paths.js";
import { deriveRepoNameFromRepoUrl } from "./heartbeat-workspace-repo-name.js";
import { sanitizeRuntimeServiceBaseEnv } from "./workspace-runtime.js";

const MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS = 10 * 60 * 1000;
const execFile = promisify(execFileCallback);

export async function ensureManagedProjectWorkspace(input: {
  companyId: string;
  agentId: string;
  projectId: string;
  repoUrl: string | null;
  worktreeCheck?: (opts: { tool: string; args: Record<string, unknown>; cwd?: string; filePath?: string; command?: string }) => Promise<void>;
}): Promise<{ cwd: string; warning: string | null }> {
  const cwd = resolveManagedProjectWorkspaceDir({
    companyId: input.companyId,
    projectId: input.projectId,
    repoName: deriveRepoNameFromRepoUrl(input.repoUrl),
  });
  await fs.mkdir(path.dirname(cwd), { recursive: true });
  const stats = await fs.stat(cwd).catch(() => null);

  if (!input.repoUrl) {
    if (!stats) {
      await fs.mkdir(cwd, { recursive: true });
    }
    return { cwd, warning: null };
  }

  const gitDirExists = await fs
    .stat(path.resolve(cwd, ".git"))
    .then((entry) => entry.isDirectory())
    .catch(() => false);
  if (gitDirExists) {
    return { cwd, warning: null };
  }

  if (stats) {
    const entries = await fs.readdir(cwd).catch(() => []);
    if (entries.length > 0) {
      return {
        cwd,
        warning: `Managed workspace path "${cwd}" already exists but is not a git checkout. Using it as-is.`,
      };
    }
    await fs.rm(cwd, { recursive: true, force: true });
  }

  try {
    // worktree: check command-execute before git clone
    if (input.worktreeCheck) {
      await input.worktreeCheck({
        tool: "command-execute",
        args: { command: "git clone", repoUrl: input.repoUrl ?? "" },
        cwd,
        command: `git clone ${input.repoUrl} ${cwd}`,
      });
    }
    await execFile("git", ["clone", input.repoUrl, cwd], {
      env: sanitizeRuntimeServiceBaseEnv(process.env),
      timeout: MANAGED_WORKSPACE_GIT_CLONE_TIMEOUT_MS,
    });
    return { cwd, warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Failed to prepare managed checkout for "${input.repoUrl}" at "${cwd}": ${reason}`);
  }
}
