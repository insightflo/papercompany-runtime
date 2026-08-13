const SUPPORTED_AGENT_PARAM_KEYS = new Set([
  "message",
  "agentId",
  "provider",
  "model",
  "to",
  "replyTo",
  "sessionId",
  "sessionKey",
  "expectedExistingSessionId",
  "thinking",
  "deliver",
  "attachments",
  "channel",
  "replyChannel",
  "accountId",
  "replyAccountId",
  "threadId",
  "groupId",
  "groupChannel",
  "groupSpace",
  "timeout",
  "bestEffortDeliver",
  "lane",
  "cwd",
  "cleanupBundleMcpOnRunEnd",
  "modelRun",
  "promptMode",
  "extraSystemPrompt",
  "bootstrapContextMode",
  "bootstrapContextRunKind",
  "acpTurnSource",
  "internalRuntimeHandoffId",
  "internalExecutionIdentityRetry",
  "internalExecutionIdentityRecoveryAttempt",
  "execApprovalFollowupExpectedSessionId",
  "internalEvents",
  "inputProvenance",
  "suppressPromptPersistence",
  "sessionEffects",
  "sourceReplyDeliveryMode",
  "disableMessageTool",
  "swarmCollector",
  "swarmOutputSchema",
  "forceRestartSafeTools",
  "forceCodeModeTools",
  "voiceWakeTrigger",
  "idempotencyKey",
  "label",
]);

const CONTEXT_ONLY_PAYLOAD_KEYS = new Set(["text", "paperclip"]);

export function splitOpenClawAgentParams(payloadTemplate: Record<string, unknown>): {
  supported: Record<string, unknown>;
  unsupported: Record<string, unknown>;
} {
  const supported: Record<string, unknown> = {};
  const unsupported: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(payloadTemplate)) {
    if (SUPPORTED_AGENT_PARAM_KEYS.has(key)) {
      supported[key] = value;
    } else if (!CONTEXT_ONLY_PAYLOAD_KEYS.has(key)) {
      unsupported[key] = value;
    }
  }

  return { supported, unsupported };
}
