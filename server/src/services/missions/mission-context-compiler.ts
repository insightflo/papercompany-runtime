import type { Db } from "@paperclipai/db";
import { asBoolean } from "../../adapters/utils.js";
import {
  buildIssueEnvelopePolicy,
  ensureMissionAgentRuntime,
} from "./mission-runtime-manager.js";

export const MISSION_RUNTIME_CONTEXT_INVARIANT =
  "Mission runtime context is a compact contract: inject full agent context once at bootstrap, then send issue envelopes plus mission state/handoff refs only.";

export type MissionIssueEnvelopePolicy = ReturnType<typeof buildIssueEnvelopePolicy>;

export type PaperclipMissionRuntimeContext = {
  runtimeId: string;
  runtimeKey: string;
  bootstrapRequired: boolean;
  fullContextInjection: boolean;
  issueEnvelopeOnly: boolean;
  invariant: string;
};

export function isPersistentMissionRuntimeEnabled(config: Record<string, unknown>): boolean {
  return (
    asBoolean(config.missionRuntimePersistent, false) === true ||
    asBoolean(config.persistentMissionRuntime, false) === true
  );
}

export function buildPaperclipMissionRuntimeContext(input: {
  runtimeId: string;
  runtimeKey: string;
  policy: MissionIssueEnvelopePolicy;
}): PaperclipMissionRuntimeContext {
  return {
    runtimeId: input.runtimeId,
    runtimeKey: input.runtimeKey,
    bootstrapRequired: input.policy.bootstrapRequired,
    fullContextInjection: input.policy.fullContextInjection,
    issueEnvelopeOnly: input.policy.issueEnvelopeOnly,
    invariant: MISSION_RUNTIME_CONTEXT_INVARIANT,
  };
}

export async function compileMissionRunContext(db: Db, input: {
  companyId: string;
  missionId?: string | null;
  agentId: string;
  adapterType: string;
  resolvedConfig: Record<string, unknown>;
  workspaceId?: string | null;
  workspaceKey?: string | null;
  currentIssueId?: string | null;
  runId: string;
  missionSessionId?: string | null;
}) {
  const supportsPersistentMissionRuntime = isPersistentMissionRuntimeEnabled(input.resolvedConfig);
  const missionAgentRuntimeForRun = input.missionId
    ? await ensureMissionAgentRuntime(db, {
        companyId: input.companyId,
        missionId: input.missionId,
        agentId: input.agentId,
        adapterType: input.adapterType,
        workspaceId: input.workspaceId ?? null,
        workspaceKey: input.workspaceKey ?? "default",
        currentIssueId: input.currentIssueId ?? null,
        runId: input.runId,
        sessionId: input.missionSessionId ?? null,
      })
    : null;
  const missionIssueEnvelopePolicy = buildIssueEnvelopePolicy({
    bootstrapRequired: missionAgentRuntimeForRun?.bootstrapRequired ?? false,
    supportsPersistentRuntime: supportsPersistentMissionRuntime,
  });

  return {
    missionAgentRuntimeForRun,
    missionIssueEnvelopePolicy,
    paperclipMissionRuntime: missionAgentRuntimeForRun
      ? buildPaperclipMissionRuntimeContext({
          runtimeId: missionAgentRuntimeForRun.runtime.id,
          runtimeKey: missionAgentRuntimeForRun.runtime.runtimeKey,
          policy: missionIssueEnvelopePolicy,
        })
      : null,
  };
}
