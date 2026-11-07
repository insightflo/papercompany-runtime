import type { heartbeatRuns } from "@paperclipai/db";
export type HeartbeatFailureClassification = {
  category: "timeout" | "cancelled" | "overload" | "quota" | "auth" | "command" | "adapter";
  reasonCode: string;
  summary: string;
  fallbackCandidates: string[];
};

export function heartbeatRunFailureText(input: {
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
}) {
  return [input.errorCode, input.errorMessage, input.stdoutExcerpt, input.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .trim();
}

export function classifyHeartbeatRunFailure(input: {
  status: string;
  adapterType?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  stdoutExcerpt?: string | null;
  stderrExcerpt?: string | null;
  provider?: string | null;
  model?: string | null;
  command?: string | null;
}): HeartbeatFailureClassification {
  const haystack = heartbeatRunFailureText(input);
  const normalized = haystack.toLowerCase();
  const providerModelCommand = [input.provider, input.model, input.command, input.adapterType]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join(" ")
    .toLowerCase();
  const fallbackCandidates: string[] = [];
  const pushFallback = (candidate: string) => {
    if (!fallbackCandidates.includes(candidate)) fallbackCandidates.push(candidate);
  };
  const looksKimiOrMimo = /\b(kimi|moonshot|mimo)\b/i.test(`${providerModelCommand}\n${haystack}`);
  if (looksKimiOrMimo) {
    pushFallback("mimo26pro command/model if configured with available quota");
    pushFallback("same-role alternate agent on a non-Kimi provider");
  }

  if (input.status === "timed_out") {
    return { category: "timeout", reasonCode: "RUN_TIMED_OUT", summary: "Heartbeat run timed out.", fallbackCandidates };
  }
  if (input.status === "cancelled") {
    return { category: "cancelled", reasonCode: "RUN_CANCELLED", summary: "Heartbeat run was cancelled.", fallbackCandidates };
  }
  // API overload(500/503/529): errorCode 를 우선 매칭한다. stderr 의 무해한
  // "ENOENT: no such"(참조 instructions 파일 누락 워닝) 가 haystack 에 섞여 아래 command
  // 분기로 오판되는 것(gazua 코난 529 run 사례) 을 막기 위해 errorCode 기반으로 먼저 잡는다.
  // 일시 overload 는 adapter 의 backoff 재시도로 극복 가능(transient) 하므로 command 가 아님.
  // 429 는 아래 quota 분기가 처리하도록 둔다.
  const overloadApiStatus = /claude_api_error_(\d+)/i.exec(input.errorCode ?? "")?.[1];
  const isOverloadApiStatus = overloadApiStatus === "500" || overloadApiStatus === "503" || overloadApiStatus === "529";
  const isOverloadMessage = /overloaded|temporarily overloaded|service is currently/i.test(input.errorMessage ?? "");
  if (isOverloadApiStatus || isOverloadMessage) {
    return {
      category: "overload",
      reasonCode: overloadApiStatus ? `PROVIDER_OVERLOADED_${overloadApiStatus}` : "PROVIDER_OVERLOADED",
      summary: "Provider temporarily overloaded (transient). Retry/backoff applicable; not a command/path/permission issue.",
      fallbackCandidates,
    };
  }
  const strongEvidenceText = [input.errorCode, input.errorMessage, input.stderrExcerpt]
    .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
    .join("\n")
    .toLowerCase();
  if (
    /step input manifest|runtime broad scan|broad scan (command|instruction)|\bfind \.|git ls-files|\bls -r|\btree\b|\bgrep -r/.test(
      strongEvidenceText,
    )
  ) {
    return {
      category: "command",
      reasonCode: "STEP_INPUT_MANIFEST_GUARDRAIL",
      summary:
        "Run blocked by a Step Input Manifest / runtime broad-scan guardrail (command-policy/input-contract). Not a provider quota/auth failure; replan the command or adjust the manifest.",
      fallbackCandidates,
    };
  }
  if (/\b(403|429)\b/.test(normalized) && /quota|rate.?limit|rate limit|insufficient|billing|capacity|exceeded/.test(normalized)) {
    return {
      category: "quota",
      reasonCode: /\b403\b/.test(normalized) ? "PROVIDER_QUOTA_OR_AUTH_403" : "PROVIDER_QUOTA_OR_RATE_LIMIT",
      summary: "Provider quota/rate-limit/auth-capacity failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/quota|insufficient_quota|rate.?limit|rate limit|billing hard limit|credits? exhausted|capacity exceeded/.test(normalized)) {
    return {
      category: "quota",
      reasonCode: "PROVIDER_QUOTA_OR_RATE_LIMIT",
      summary: "Provider quota or rate-limit failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/\b401\b|unauthorized|invalid api key|invalid token|authentication failed|reauth|required|login required|forbidden/.test(normalized)) {
    return {
      category: "auth",
      reasonCode: /\b403\b/.test(normalized) ? "PROVIDER_AUTH_OR_FORBIDDEN_403" : "PROVIDER_AUTH_FAILURE",
      summary: "Provider authentication/authorization failure detected from run output.",
      fallbackCandidates,
    };
  }
  if (/enoent|command not found|spawn .* enoent|no such file or directory|eacces|permission denied|not executable/.test(normalized)) {
    return {
      category: "command",
      reasonCode: "COMMAND_EXECUTION_FAILURE",
      summary: "Adapter command/path/permission failure detected from run output.",
      fallbackCandidates,
    };
  }
  return {
    category: "adapter",
    reasonCode: input.errorCode?.trim() || "ADAPTER_RUN_FAILED",
    summary: "Adapter run failed without a more specific local classification.",
    fallbackCandidates,
  };
}

export function containsToolLimitLifecycleFailure(run: typeof heartbeatRuns.$inferSelect) {
  const text = [run.stdoutExcerpt, run.stderrExcerpt, run.error].filter(Boolean).join("\n");
  return /reached maximum iterations|tool[-\s]?call limit|tool capacity|could not post|couldn't post|not able to post|before i could post|could not .*mark|couldn't .*mark/iu.test(text);
}
