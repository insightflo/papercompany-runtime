import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  DEFAULT_BRIDGE_BASE_URL,
  DEFAULT_HISTORY_LIMIT,
  DEFAULT_REQUEST_TIMEOUT_MS,
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
  WEBHOOK_ENDPOINT_KEYS,
  WORKFLOW_CATEGORY_MAP,
} from "./constants.js";
import { allowedCategories, workflowKeys } from "./validate.js";

const capabilities = [
  "http.outbound",
  "secrets.read-ref",
  "plugin.state.read",
  "plugin.state.write",
  "agent.tools.register",
  "webhooks.receive",
  "ui.page.register",
  "ui.sidebar.register",
] as unknown as PaperclipPluginManifestV1["capabilities"];

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "PC Bridge (네이버 발행 지시)",
  description:
    "A1에서 실행할 수 없는 브라우저 자동화(네이버 블로그 발행)를 운영자 PC(맥) 브리지로 전달합니다. SSH 역방향 터널로 노출된 맥 브리지에 검증된 발행 지시를 프록시합니다.",
  author: "InsightFlo",
  categories: ["automation", "connector"],
  capabilities,
  entrypoints: {
    worker: "./dist/worker.js",
    ui: "./dist/ui",
  },
  tools: [
    {
      name: TOOL_NAMES.publish,
      displayName: "PC 브리지 발행 지시",
      description: [
        "운영자 PC(맥) 브리지에 네이버 블로그 발행을 지시합니다.",
        `url은 https 이며 허용 호스트만 가능합니다. workflow는 ${workflowKeys().join(", ")} 중 하나이며 카테고리로 매핑됩니다.`,
        `category를 직접 지정할 때는 ${allowedCategories().join(", ")} 중 하나여야 합니다.`,
        "workflow와 category는 동시에 지정할 수 없습니다. 발행 결과(퍼머링크/제목/이미지 수)를 반환합니다.",
      ].join(" "),
      parametersSchema: {
        type: "object",
        properties: {
          url: {
            type: "string",
            description: "발행할 콘텐츠 URL (https, 허용 호스트만)",
          },
          workflow: {
            type: "string",
            description: "워크플로우 키 (category 대신 사용)",
            enum: workflowKeys(),
          },
          category: {
            type: "string",
            description: "네이버 카테고리명 (workflow 대신 직접 지정)",
            enum: allowedCategories(),
          },
        },
        required: ["url"],
      },
    },
  ],
  webhooks: [
    {
      endpointKey: WEBHOOK_ENDPOINT_KEYS.publish,
      displayName: "PC Bridge Publish",
      description:
        "A1 스크립트가 발행 지시를 직접 POST하기 위한 엔드포인트. 헤더 X-Papercompany-Webhook-Key 필수.",
    },
  ],
  instanceConfigSchema: {
    type: "object",
    properties: {
      bridgeBaseUrl: {
        type: "string",
        title: "PC 브리지 주소",
        description: "SSH -R 터널로 A1 루프백에 노출된 맥 브리지 주소",
        default: DEFAULT_BRIDGE_BASE_URL,
      },
      webhookKeyRef: {
        type: "string",
        title: "웹훅 키 시크릿 참조",
        description: "맥 브리지 웹훅 키의 시크릿 참조 (권장)",
      },
      webhookKey: {
        type: "string",
        title: "웹훅 키 (인라인)",
        description: "시크릿 참조를 사용하지 않을 때의 인라인 폴백. 코드에 하드코딩하지 말고 설정에만 입력하세요.",
      },
      requestTimeoutMs: {
        type: "number",
        title: "요청 타임아웃(ms)",
        description: "맥 브리지 발행 요청 타임아웃. 브라우저 발행은 수 분이 걸릴 수 있습니다.",
        default: DEFAULT_REQUEST_TIMEOUT_MS,
      },
      historyLimit: {
        type: "number",
        title: "발행 이력 최대 보관 수",
        default: DEFAULT_HISTORY_LIMIT,
      },
    },
  },
  ui: {
    slots: [
      {
        type: "page",
        id: SLOT_IDS.page,
        displayName: "PC Bridge",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: "sidebar",
        id: SLOT_IDS.sidebar,
        displayName: "PC Bridge",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  } as PaperclipPluginManifestV1["ui"],
};

export default manifest;
