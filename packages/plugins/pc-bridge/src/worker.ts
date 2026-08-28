import {
  createHash,
  timingSafeEqual,
} from "node:crypto";
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginWebhookInput,
  type ToolResult,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  HEALTH_TIMEOUT_MS,
  PLUGIN_ID,
  TOOL_NAMES,
  WEBHOOK_ENDPOINT_KEYS,
  WEBHOOK_KEY_HEADER,
  WORKFLOW_CATEGORY_MAP,
} from "./constants.js";
import {
  isWebhookKeyConfigured,
  resolvePcBridgeConfig,
  validatePcBridgeConfig,
  type PcBridgeConfig,
} from "./config.js";
import {
  checkBridgeHealth,
  postPublishToBridge,
  resolveWebhookKey,
  type BridgePublishResult,
} from "./bridge.js";
import {
  buildHistoryEntry,
  listPublishHistory,
  recordPublishHistory,
  type PublishOutcome,
  type PublishSource,
} from "./history.js";
import {
  validatePublishRequest,
  workflowKeys,
  type ValidatedPublishRequest,
} from "./validate.js";

type JsonRecord = Record<string, unknown>;

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function registerDataHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const dataClient = ctx.data as PluginContext["data"] & {
    handle?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof dataClient.handle === "function") {
    dataClient.handle(key, handler);
    return;
  }

  if (typeof dataClient.register === "function") {
    dataClient.register(key, handler);
    return;
  }

  throw new Error("Plugin data client does not support handler registration");
}

function registerActionHandler(
  ctx: PluginContext,
  key: string,
  handler: (params: JsonRecord) => Promise<unknown>,
): void {
  const actionClient = ctx.actions as PluginContext["actions"] & {
    register?: (handlerKey: string, fn: (params: JsonRecord) => Promise<unknown>) => void;
  };

  if (typeof actionClient.register === "function") {
    actionClient.register(key, handler);
    return;
  }

  throw new Error("Plugin action client does not support handler registration");
}

function safeEqualStrings(actual: string, expected: string): boolean {
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest);
}

function headerValue(input: PluginWebhookInput, name: string): string {
  const found = Object.entries(input.headers).find(([key]) => key.toLowerCase() === name);
  const value = found?.[1];
  const first = Array.isArray(value) ? value[0] : value;
  return typeof first === "string" ? first.trim() : "";
}

function failureMessage(result: BridgePublishResult): string {
  const bodyMessage = result.body && typeof result.body.message === "string"
    ? result.body.message.trim()
    : "";
  const bodyError = result.body && typeof result.body.error === "string"
    ? result.body.error.trim()
    : "";

  if (result.error) {
    return result.error;
  }

  return bodyMessage || bodyError || "PC 브리지 발행이 실패했습니다.";
}

async function executePublish(
  ctx: PluginContext,
  params: JsonRecord,
  source: PublishSource,
): Promise<PublishOutcome | { error: string }> {
  const validation = validatePublishRequest({
    url: params.url,
    workflow: params.workflow,
    category: params.category,
  });

  if (!validation.ok) {
    return { error: validation.error };
  }

  const config = resolvePcBridgeConfig(await ctx.config.get());

  if (!isWebhookKeyConfigured(config)) {
    return {
      error: "웹훅 키가 설정되지 않았습니다. 플러그인 설정에서 webhookKeyRef 또는 webhookKey를 지정하세요.",
    };
  }

  const webhookKey = await resolveWebhookKey(ctx, config);
  if (!webhookKey) {
    return { error: "설정된 웹훅 키가 비어 있습니다. 시크릿 참조 또는 인라인 값을 확인하세요." };
  }

  return await dispatchToBridge(ctx, config, webhookKey, validation.request, source);
}

async function dispatchToBridge(
  ctx: PluginContext,
  config: PcBridgeConfig,
  webhookKey: string,
  request: ValidatedPublishRequest,
  source: PublishSource,
): Promise<PublishOutcome> {
  const startedAt = Date.now();
  const result = await postPublishToBridge(ctx.http, {
    baseUrl: config.bridgeBaseUrl,
    webhookKey,
    request,
    timeoutMs: config.requestTimeoutMs,
  });
  const durationMs = Date.now() - startedAt;

  const entry = buildHistoryEntry({ source, request, result, durationMs });
  try {
    await recordPublishHistory(ctx, config, entry);
  } catch (error) {
    ctx.logger.warn("Failed to record publish history", {
      error: summarizeError(error),
      url: request.url,
    });
  }

  ctx.logger.info("PC bridge publish dispatched", {
    source,
    url: request.url,
    workflow: request.workflow,
    category: entry.category,
    ok: result.ok,
    httpStatus: result.httpStatus,
    durationMs,
  });

  return { entry, result };
}

async function buildStatusSnapshot(ctx: PluginContext): Promise<unknown> {
  const config = resolvePcBridgeConfig(await ctx.config.get());
  const health = await checkBridgeHealth(ctx.http, config.bridgeBaseUrl);
  const history = await listPublishHistory(ctx, config.historyLimit);

  return {
    generatedAt: new Date().toISOString(),
    config: {
      bridgeBaseUrl: config.bridgeBaseUrl,
      webhookKeyRef: config.webhookKeyRef,
      webhookKeyConfigured: isWebhookKeyConfigured(config),
      requestTimeoutMs: config.requestTimeoutMs,
      historyLimit: config.historyLimit,
    },
    health,
    workflows: workflowKeys().map((workflow) => ({
      workflow,
      category: WORKFLOW_CATEGORY_MAP[workflow],
    })),
    history,
  };
}

function toolResultFor(outcome: PublishOutcome | { error: string }): ToolResult {
  if ("error" in outcome) {
    return { error: outcome.error };
  }

  const { entry, result } = outcome;

  if (!result.ok) {
    return {
      error: failureMessage(result),
      data: { ok: false, httpStatus: result.httpStatus, response: result.body },
    };
  }

  const lines = [
    "PC 브리지 발행 완료",
    `- 제목: ${entry.title ?? "(unknown)"}`,
    `- 카테고리: ${entry.category ?? "(unknown)"}`,
    `- 퍼머링크: ${entry.permalink ?? "(unknown)"}`,
    `- 이미지 수: ${entry.imageCount ?? 0}`,
  ];
  if (entry.message) {
    lines.push(`- 메시지: ${entry.message}`);
  }

  return {
    content: lines.join("\n"),
    data: { ok: true, httpStatus: result.httpStatus, response: result.body, permalink: entry.permalink },
  };
}

async function handlePublishWebhook(ctx: PluginContext, input: PluginWebhookInput): Promise<void> {
  const config = resolvePcBridgeConfig(await ctx.config.get());

  if (!isWebhookKeyConfigured(config)) {
    throw new Error("웹훅 키가 설정되지 않아 요청을 검증할 수 없습니다.");
  }

  const presentedKey = headerValue(input, WEBHOOK_KEY_HEADER);
  const expectedKey = await resolveWebhookKey(ctx, config);

  if (!presentedKey || !expectedKey || !safeEqualStrings(presentedKey, expectedKey)) {
    throw new Error("X-Papercompany-Webhook-Key 헤더가 유효하지 않습니다.");
  }

  let payload: unknown = input.parsedBody;
  if (payload === undefined || payload === null) {
    try {
      payload = JSON.parse(input.rawBody);
    } catch {
      throw new Error("요청 본문을 JSON으로 파싱할 수 없습니다.");
    }
  }

  const record = (payload && typeof payload === "object" ? payload : {}) as JsonRecord;
  const outcome = await executePublish(ctx, record, "webhook");

  if ("error" in outcome) {
    throw new Error(outcome.error);
  }

  if (!outcome.result.ok) {
    throw new Error(failureMessage(outcome.result));
  }
}

let pluginContext: PluginContext | null = null;

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    pluginContext = ctx;
    registerDataHandler(ctx, DATA_KEYS.status, async () => {
      return await buildStatusSnapshot(ctx);
    });

    registerActionHandler(ctx, ACTION_KEYS.publish, async (params) => {
      return await executePublish(ctx, params, "ui");
    });

    ctx.tools.register(
      TOOL_NAMES.publish,
      {
        displayName: "PC 브리지 발행 지시",
        description: [
          "운영자 PC(맥) 브리지에 네이버 블로그 발행을 지시합니다.",
          `url은 https 이며 허용 호스트만 가능합니다. workflow는 ${workflowKeys().join(", ")} 중 하나이며 카테고리로 매핑됩니다.`,
          "workflow와 category는 동시에 지정할 수 없습니다. 발행 결과(퍼머링크/제목/이미지 수)를 반환합니다.",
        ].join(" "),
        parametersSchema: {
          type: "object",
          properties: {
            url: { type: "string", description: "발행할 콘텐츠 URL (https, 허용 호스트만)" },
            workflow: { type: "string", description: "워크플로우 키 (category 대신 사용)", enum: workflowKeys() },
            category: { type: "string", description: "네이버 카테고리명 (workflow 대신 직접 지정)" },
          },
          required: ["url"],
        },
      },
      async (params: unknown): Promise<ToolResult> => {
        const record = (params && typeof params === "object" ? params : {}) as JsonRecord;
        const outcome = await executePublish(ctx, record, "tool");
        return toolResultFor(outcome);
      },
    );

    ctx.logger.info("PC Bridge plugin worker initialized", {
      pluginId: PLUGIN_ID,
      publishPath: "/naver-publish",
      healthPath: "/health",
    });
  },

  async onWebhook(input: PluginWebhookInput) {
    if (input.endpointKey !== WEBHOOK_ENDPOINT_KEYS.publish) {
      throw new Error(`지원하지 않는 웹훅 엔드포인트입니다: ${input.endpointKey}`);
    }

    const ctx = pluginContext;
    if (!ctx) {
      throw new Error("PC Bridge worker가 아직 초기화되지 않았습니다.");
    }

    await handlePublishWebhook(ctx, input);
  },

  async onValidateConfig(config) {
    return validatePcBridgeConfig(config);
  },

  async onHealth() {
    return {
      status: "ok",
      message: "PC Bridge worker ready",
      details: {
        healthCheckTimeoutMs: HEALTH_TIMEOUT_MS,
      },
    };
  },
});


export default plugin;
runWorker(plugin, import.meta.url);
