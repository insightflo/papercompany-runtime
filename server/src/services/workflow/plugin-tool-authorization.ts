import { readRunToolContract } from "@paperclipai/adapter-utils";

export type RunToolAuthorizationActor =
  | { type: "agent"; agentId: string; companyId: string }
  | { type: "board" };

export type RunToolAuthorizationRun = {
  id: string;
  agentId: string;
  companyId: string;
  status?: string | null;
  contextSnapshot: unknown;
};

export type RunToolAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: string };

export function authorizeRunToolExecution(input: {
  actor: RunToolAuthorizationActor;
  runContext: { agentId: string; runId: string; companyId: string };
  run: RunToolAuthorizationRun | null;
  toolName: string;
  currentEffectiveGrant: boolean;
  registeredEnabledTool: boolean;
}): RunToolAuthorizationResult {
  if (input.actor.type === "board") return { allowed: true };
  if (!input.run) return { allowed: false, reason: "Agent run context is not valid for tool execution" };
  if (
    input.run.id !== input.runContext.runId
    || input.run.agentId !== input.runContext.agentId
    || input.run.companyId !== input.runContext.companyId
    || input.actor.agentId !== input.runContext.agentId
    || input.actor.companyId !== input.runContext.companyId
  ) {
    return { allowed: false, reason: "Agent run context is not valid for tool execution" };
  }
  if (input.run.status !== "running") {
    return { allowed: false, reason: "Agent run context is not running" };
  }

  const contract = readRunToolContract(input.run.contextSnapshot);
  if (!contract || !contract.toolNames.includes(input.toolName)) {
    return { allowed: false, reason: `Workflow tool "${input.toolName}" is not allowed for this agent run` };
  }
  if (!input.currentEffectiveGrant) {
    return { allowed: false, reason: `Workflow tool "${input.toolName}" is not granted to this agent run` };
  }
  if (!input.registeredEnabledTool) {
    return { allowed: false, reason: `Workflow tool "${input.toolName}" is not registered or enabled` };
  }

  return { allowed: true };
}
