import type { agents } from "@paperclipai/db";
import { resolveSessionCompactionPolicy, type SessionCompactionPolicy } from "@paperclipai/adapter-utils";
import { HttpError } from "../errors.js";
import { getServerAdapter } from "../adapters/index.js";
import type { AdapterExecutionResult, AdapterSessionCodec } from "../adapters/index.js";
import { parseObject } from "../adapters/utils.js";
import { readNonEmptyString } from "./heartbeat-run-context.js";

export function truncateDisplayId(value: string | null | undefined, max = 128) {
  if (!value) return null;
  return value.length > max ? value.slice(0, max) : value;
}

const defaultSessionCodec: AdapterSessionCodec = {
  deserialize(raw: unknown) {
    const asObj = parseObject(raw);
    if (Object.keys(asObj).length > 0) return asObj;
    const sessionId = readNonEmptyString((raw as Record<string, unknown> | null)?.sessionId);
    if (sessionId) return { sessionId };
    return null;
  },
  serialize(params: Record<string, unknown> | null) {
    if (!params || Object.keys(params).length === 0) return null;
    return params;
  },
  getDisplayId(params: Record<string, unknown> | null) {
    return readNonEmptyString(params?.sessionId);
  },
};

export function getAdapterSessionCodec(adapterType: string) {
  const adapter = getServerAdapter(adapterType);
  return adapter.sessionCodec ?? defaultSessionCodec;
}

export function buildMissionSessionSecretName(input: {
  missionId: string;
  agentId: string;
  adapterType: string;
}) {
  return `mission-session:${input.missionId}:${input.agentId}:${input.adapterType}`;
}

export function isRecoverableMissionSessionSecretReadError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof HttpError) {
    return error.status === 400 && message.includes("Invalid local_encrypted secret material");
  }
  return (
    message.includes("Unsupported state or unable to authenticate data") ||
    message.includes("Invalid initialization vector") ||
    message.includes("Invalid authentication tag length")
  );
}

export function normalizeSessionParams(params: Record<string, unknown> | null | undefined) {
  if (!params) return null;
  return Object.keys(params).length > 0 ? params : null;
}

export type MissionSessionAuthorityDecision = {
  missionKnown: boolean;
  defaultAuthority: "mission_session" | "task_session" | "runtime_state" | "none";
  compatibilitySeedSessionId: string | null;
  preferredSessionId: string | null;
};

export function resolveMissionSessionAuthorityDecision(input: {
  missionId?: string | null;
  missionSessionId?: string | null;
  taskSessionDisplayId?: string | null;
  taskSessionLegacySessionId?: string | null;
  runtimeSessionId?: string | null;
  resetTaskSession?: boolean;
}): MissionSessionAuthorityDecision {
  const missionId = readNonEmptyString(input.missionId);
  const resetTaskSession = input.resetTaskSession === true;
  const taskSessionDisplayId = truncateDisplayId(readNonEmptyString(input.taskSessionDisplayId));
  const taskSessionLegacySessionId = readNonEmptyString(input.taskSessionLegacySessionId);
  const runtimeSessionId = readNonEmptyString(input.runtimeSessionId);

  if (missionId) {
    return {
      missionKnown: true,
      defaultAuthority: "mission_session",
      compatibilitySeedSessionId:
        resetTaskSession ? null : (taskSessionDisplayId ?? taskSessionLegacySessionId ?? null),
      preferredSessionId: readNonEmptyString(input.missionSessionId),
    };
  }

  if (resetTaskSession) {
    return {
      missionKnown: false,
      defaultAuthority: "none",
      compatibilitySeedSessionId: null,
      preferredSessionId: null,
    };
  }

  const taskSessionId = taskSessionDisplayId ?? taskSessionLegacySessionId ?? null;
  if (taskSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "task_session",
      compatibilitySeedSessionId: null,
      preferredSessionId: taskSessionId,
    };
  }

  if (runtimeSessionId) {
    return {
      missionKnown: false,
      defaultAuthority: "runtime_state",
      compatibilitySeedSessionId: null,
      preferredSessionId: runtimeSessionId,
    };
  }

  return {
    missionKnown: false,
    defaultAuthority: "none",
    compatibilitySeedSessionId: null,
    preferredSessionId: null,
  };
}

export function resolveNextSessionState(input: {
  codec: AdapterSessionCodec;
  adapterResult: AdapterExecutionResult;
  previousParams: Record<string, unknown> | null;
  previousDisplayId: string | null;
  previousLegacySessionId: string | null;
}) {
  const { codec, adapterResult, previousParams, previousDisplayId, previousLegacySessionId } = input;

  if (adapterResult.clearSession) {
    return {
      params: null as Record<string, unknown> | null,
      displayId: null as string | null,
      legacySessionId: null as string | null,
    };
  }

  const explicitParams = adapterResult.sessionParams;
  const hasExplicitParams = adapterResult.sessionParams !== undefined;
  const hasExplicitSessionId = adapterResult.sessionId !== undefined;
  const explicitSessionId = readNonEmptyString(adapterResult.sessionId);
  const hasExplicitDisplay = adapterResult.sessionDisplayId !== undefined;
  const explicitDisplayId = readNonEmptyString(adapterResult.sessionDisplayId);
  const shouldUsePrevious = !hasExplicitParams && !hasExplicitSessionId && !hasExplicitDisplay;

  const candidateParams =
    hasExplicitParams
      ? explicitParams
      : hasExplicitSessionId
        ? (explicitSessionId ? { sessionId: explicitSessionId } : null)
        : previousParams;

  const serialized = normalizeSessionParams(codec.serialize(normalizeSessionParams(candidateParams) ?? null));
  const deserialized = normalizeSessionParams(codec.deserialize(serialized));

  const displayId = truncateDisplayId(
    explicitDisplayId ??
      (codec.getDisplayId ? codec.getDisplayId(deserialized) : null) ??
      readNonEmptyString(deserialized?.sessionId) ??
      (shouldUsePrevious ? previousDisplayId : null) ??
      explicitSessionId ??
      (shouldUsePrevious ? previousLegacySessionId : null),
  );

  const legacySessionId =
    explicitSessionId ??
    readNonEmptyString(deserialized?.sessionId) ??
    displayId ??
    (shouldUsePrevious ? previousLegacySessionId : null);

  return {
    params: serialized,
    displayId,
    legacySessionId,
  };
}

export function parseSessionCompactionPolicy(agent: typeof agents.$inferSelect): SessionCompactionPolicy {
  return resolveSessionCompactionPolicy(agent.adapterType, agent.runtimeConfig).policy;
}
