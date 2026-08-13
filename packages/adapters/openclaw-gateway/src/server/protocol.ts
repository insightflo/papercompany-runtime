export type GatewayProtocolVersion = 3 | 4;

export type GatewayProtocolSelection = {
  minProtocol: GatewayProtocolVersion;
  maxProtocol: GatewayProtocolVersion;
  fallbackProtocol: GatewayProtocolVersion | null;
};

export type GatewaySessionKeyStrategy = "fixed" | "issue" | "run";

export type GatewayChatTranscript = {
  text: string;
  lastSeq: number | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function nonEmpty(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function parseProtocolVersion(value: unknown, fieldName: string): GatewayProtocolVersion | null {
  if (value == null || (typeof value === "string" && value.trim() === "")) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  if (parsed === 3 || parsed === 4) return parsed;
  throw new Error(`${fieldName} must be 3 or 4`);
}

export function resolveGatewayProtocol(config: Record<string, unknown>): GatewayProtocolSelection {
  const pinned = parseProtocolVersion(config.protocolVersion, "protocolVersion");
  if (pinned) {
    return { minProtocol: pinned, maxProtocol: pinned, fallbackProtocol: null };
  }

  const configuredMin = parseProtocolVersion(config.minProtocol, "minProtocol");
  const configuredMax = parseProtocolVersion(config.maxProtocol, "maxProtocol");
  const minProtocol = configuredMin ?? 3;
  const maxProtocol = configuredMax ?? 4;
  if (minProtocol > maxProtocol) {
    throw new Error("minProtocol must not be greater than maxProtocol");
  }

  const configuredFallback = parseProtocolVersion(
    config.fallbackProtocolVersion,
    "fallbackProtocolVersion",
  );
  const fallbackProtocol = configuredFallback ?? (minProtocol === 3 && maxProtocol === 4 ? 3 : null);
  if (fallbackProtocol != null && (fallbackProtocol < minProtocol || fallbackProtocol > maxProtocol)) {
    throw new Error("fallbackProtocolVersion must be inside the configured protocol range");
  }

  return { minProtocol, maxProtocol, fallbackProtocol };
}

export function fallbackGatewayProtocol(
  selection: GatewayProtocolSelection,
): GatewayProtocolSelection | null {
  if (selection.fallbackProtocol == null) return null;
  return {
    minProtocol: selection.fallbackProtocol,
    maxProtocol: selection.fallbackProtocol,
    fallbackProtocol: null,
  };
}

export function isGatewayProtocolMismatch(error: unknown): boolean {
  const record = asRecord(error);
  if (!record) return false;

  const gatewayCode = nonEmpty(record.gatewayCode);
  if (!gatewayCode) return false;

  if (/protocol/i.test(gatewayCode) && /(?:unsupported|invalid|mismatch|incompatible|range)/i.test(gatewayCode)) {
    return true;
  }

  const details = asRecord(record.gatewayDetails);
  const detailCode = nonEmpty(details?.code);
  if (detailCode) {
    return (
      /protocol/i.test(detailCode) &&
      /(?:unsupported|invalid|mismatch|incompatible|range)/i.test(detailCode)
    );
  }

  if (/^(?:invalid[_-]?request|bad[_-]?request|error)$/i.test(gatewayCode)) {
    const message = nonEmpty(record.message);
    return Boolean(message && /(?:protocol|version).*(?:unsupported|invalid|mismatch|incompatible|range)/i.test(message));
  }

  return false;
}

function prefixSessionKeyForAgent(sessionKey: string, agentId: string | null): string {
  if (!agentId || sessionKey.startsWith("agent:")) return sessionKey;
  return `agent:${agentId}:${sessionKey}`;
}

export function buildAgentScopedSessionKey(input: {
  strategy: GatewaySessionKeyStrategy;
  configuredSessionKey: string | null;
  agentId: string | null;
  runId: string;
  issueId: string | null;
}): string {
  const fallback = input.configuredSessionKey ?? "paperclip";
  if (input.strategy === "run") {
    return prefixSessionKeyForAgent(`paperclip:run:${input.runId}`, input.agentId);
  }
  if (input.strategy === "issue" && input.issueId) {
    return prefixSessionKeyForAgent(`paperclip:issue:${input.issueId}`, input.agentId);
  }
  return prefixSessionKeyForAgent(fallback, input.agentId);
}

export function extractGatewayText(value: unknown): string | null {
  const direct = nonEmpty(value);
  if (direct) return direct;

  if (Array.isArray(value)) {
    const text = value
      .map((entry) => extractGatewayText(entry))
      .filter((entry): entry is string => Boolean(entry))
      .join("");
    return text || null;
  }

  const record = asRecord(value);
  if (!record) return null;

  const content = extractGatewayText(record.content);
  if (content) return content;
  const text = nonEmpty(record.text) ?? nonEmpty(record.deltaText) ?? nonEmpty(record.summary);
  return text;
}

export function applyGatewayChatEvent(
  transcript: GatewayChatTranscript,
  input: {
    state?: unknown;
    deltaText?: unknown;
    message?: unknown;
    replace?: unknown;
    seq?: unknown;
  },
): GatewayChatTranscript {
  const seq = typeof input.seq === "number" && Number.isFinite(input.seq) ? input.seq : null;
  if (seq != null && transcript.lastSeq != null && seq <= transcript.lastSeq) return transcript;

  const delta = nonEmpty(input.deltaText);
  const snapshot = extractGatewayText(input.message);
  const replace = input.replace === true;
  let text = transcript.text;

  if (replace) {
    text = snapshot ?? delta ?? text;
  } else {
    if (delta) text += delta;
    if (snapshot && (!delta || snapshot === text || snapshot.startsWith(text) || text.startsWith(snapshot))) {
      text = snapshot;
    }
  }

  return {
    text,
    lastSeq: seq ?? transcript.lastSeq,
  };
}
