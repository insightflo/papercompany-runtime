OpenAI Codex v0.116.0 (research preview)
--------
workdir: /Users/kwak/Projects/paperclip/paperclip-addon
model: gpt-5.3-codex
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/kwak/.codex/memories]
reasoning effort: high
reasoning summaries: none
session id: 019d1e1f-4f71-7d43-a59f-e13a06a8200e
--------
user

Paperclip Plugin 개발. Plugin SDK 참고: /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk
기존 Plugin 참고: /Users/kwak/Projects/paperclip/paperclip-addon/plugins/workflow-engine/ (같은 구조로)

## 프로젝트 경로
plugins/knowledge-base/ 에 생성

## 규칙
- Company ID, Agent ID 하드코딩 절대 금지. name 기반 API resolve
- ctx.entities 사용 (ctx.state 아님)

## Knowledge Base Plugin 구현

에이전트가 업무 지식/규정을 참조할 수 있게 하는 Plugin.
회사 수준에서 지식 소스를 등록하고, 에이전트별 접근 권한을 부여.

### 파일 구조

plugins/knowledge-base/
├── package.json          — name: @insightflo/paperclip-knowledge-base
├── tsconfig.json
├── scripts/build-ui.mjs
└── src/
    ├── constants.ts      — PLUGIN_ID, ENTITY_TYPES, SLOT_IDS
    ├── index.ts
    ├── manifest.ts       — capabilities + UI slots
    ├── worker.ts         — agent.run.started → KB 주입 + data handlers
    ├── kb-store.ts       — ctx.entities 기반 KnowledgeBase/AgentKBGrant CRUD
    └── ui/index.tsx      — KB 목록 + 에이전트 연결 UI

### 핵심 로직

1. KnowledgeBase entity:
   - name, type (static|rag|ontology), description, companyId
   - maxTokenBudget (기본 4096)
   - staticConfig: { content: string } (파일 내용 직접 저장)
   - ragConfig: { mcpServerUrl, topK } (Phase 2 확장)
   - ontologyConfig: { kgPath } (Phase 3 확장)

2. AgentKBGrant entity:
   - agentName (name 기반, ID 금지), kbName, grantedBy

3. worker.ts:
   - agent.run.started 이벤트:
     a) agentId → agent name resolve (ctx.agents.get)
     b) agent의 KB grant 목록 조회
     c) 각 KB의 type에 따라:
        - static: content를 maxTokenBudget까지 truncate → 이슈 코멘트로 주입
        - rag/ontology: 향후 확장 (현재 로그만)
     d) 주입 시 포맷: '## 참조 지식: {KB name}\n{content}'
   - data handlers: KB CRUD, Grant CRUD (UI에서 호출)

4. ui/index.tsx:
   - page: KB 목록 (이름, 타입, 토큰 예산)
   - page: KB 상세 (static 내용 편집)
   - page: 에이전트-KB 연결 매핑
   - sidebar: KB 바로가기

전체 파일을 생성하세요.

mcp: pencil starting
mcp: stitch starting
mcp: pencil ready
mcp: stitch ready
mcp startup: ready: pencil, stitch
codex
요청하신 `plugins/knowledge-base` 플러그인을 `workflow-engine`와 동일한 구조로 스캐폴딩하고, SDK 규칙(`name` 기반 resolve, `ctx.entities` 사용)을 지켜 전체 파일을 생성하겠습니다. 먼저 기존 `workflow-engine`와 SDK 인터페이스를 빠르게 읽고 정확한 타입/핸들러 시그니처를 맞추겠습니다.
exec
/bin/zsh -lc "sed -n '1,220p' /Users/kwak/Projects/paperclip/paperclip-orginal/skills/paperclip-create-plugin/SKILL.md" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
---
name: paperclip-create-plugin
description: >
  Create new Paperclip plugins with the current alpha SDK/runtime. Use when
  scaffolding a plugin package, adding a new example plugin, or updating plugin
  authoring docs. Covers the supported worker/UI surface, route conventions,
  scaffold flow, and verification steps.
---

# Create a Paperclip Plugin

Use this skill when the task is to create, scaffold, or document a Paperclip plugin.

## 1. Ground rules

Read these first when needed:

1. `doc/plugins/PLUGIN_AUTHORING_GUIDE.md`
2. `packages/plugins/sdk/README.md`
3. `doc/plugins/PLUGIN_SPEC.md` only for future-looking context
exec
/bin/zsh -lc 'pwd && ls -la' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/Users/kwak/Projects/paperclip/paperclip-addon
total 2240
drwxr-xr-x  18 kwak  staff     576 Mar 24 11:57 .
drwxr-xr-x@ 15 kwak  staff     480 Mar 24 09:13 ..
-rw-r--r--@  1 kwak  staff    6148 Mar 24 09:10 .DS_Store
-rw-r--r--@  1 kwak  staff   10445 Mar 24 11:57 TASKS.md
drwxr-xr-x@  4 kwak  staff     128 Mar 24 10:29 agents
drwxr-xr-x@  5 kwak  staff     160 Mar 23 16:21 docs
drwxr-xr-x@ 14 kwak  staff     448 Mar 24 08:58 logs
-rw-r--r--@  1 kwak  staff  171314 Mar 19 15:48 paperclip-korean-final.png
-rw-r--r--@  1 kwak  staff  180985 Mar 19 15:47 paperclip-korean-ui.png
-rw-r--r--@  1 kwak  staff  172120 Mar 19 15:54 paperclip-light-confirmed.png
-rw-r--r--@  1 kwak  staff  154444 Mar 19 15:49 paperclip-org-chart.png
-rw-r--r--@  1 kwak  staff  350168 Mar 19 16:17 paperclip-running.png
drwxr-xr-x@  6 kwak  staff     192 Mar 24 13:20 plugins
drwxr-xr-x@  3 kwak  staff      96 Mar 23 00:23 qa-artifacts
drwxr-xr-x@  8 kwak  staff     256 Mar 24 08:55 reports
drwxr-xr-x@ 14 kwak  staff     448 Mar 24 10:25 scripts
drwxr-xr-x@  9 kwak  staff     288 Mar 23 13:27 tmp
-rw-r--r--@  1 kwak  staff   83784 Mar 20 16:11 tmp-issues.json
codex
`paperclip-create-plugin` 스킬 가이드를 적용해서 진행 중입니다. 지금은 `workflow-engine` 구현과 SDK 타입 정의를 함께 읽어 `worker/data/ui` 시그니처를 정확히 맞추겠습니다.
exec
/bin/zsh -lc 'find plugins/workflow-engine -maxdepth 3 -type f | sort' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
plugins/workflow-engine/dist/constants.d.ts
plugins/workflow-engine/dist/constants.js
plugins/workflow-engine/dist/dag-engine.d.ts
plugins/workflow-engine/dist/dag-engine.js
plugins/workflow-engine/dist/index.d.ts
plugins/workflow-engine/dist/index.js
plugins/workflow-engine/dist/manifest.d.ts
plugins/workflow-engine/dist/manifest.js
plugins/workflow-engine/dist/reconciler.d.ts
plugins/workflow-engine/dist/reconciler.js
plugins/workflow-engine/dist/ui/index.d.ts
plugins/workflow-engine/dist/ui/index.js
plugins/workflow-engine/dist/worker.d.ts
plugins/workflow-engine/dist/worker.js
plugins/workflow-engine/dist/workflow-store.d.ts
plugins/workflow-engine/dist/workflow-store.js
plugins/workflow-engine/dist/workflow-utils.d.ts
plugins/workflow-engine/dist/workflow-utils.js
plugins/workflow-engine/package.json
plugins/workflow-engine/scripts/build-ui.mjs
exec
/bin/zsh -lc 'find /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk -maxdepth 3 -type f | sort' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/bundlers.d.ts
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/bundlers.d.ts.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/bundlers.js
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/bundlers.js.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/define-plugin.d.ts
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/define-plugin.d.ts.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/define-plugin.js
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/define-plugin.js.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-cli.d.ts
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-cli.d.ts.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-cli.js
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-cli.js.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-server.d.ts
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-server.d.ts.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-server.js
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/dev-server.js.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/host-client-factory.d.ts
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/host-client-factory.d.ts.map
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/dist/host-client-factory.js
exec
/bin/zsh -lc "sed -n '1,220p' plugins/workflow-engine/package.json" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
{
  "name": "@insightflo/paperclip-workflow-engine",
  "version": "0.1.0",
  "description": "DAG-based workflow engine plugin for Paperclip — orchestrates multi-step agent workflows with dependency resolution, reconciliation, and failure policies",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "build": "tsc && node ./scripts/build-ui.mjs",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
exec
/bin/zsh -lc 'ls -la plugins' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
total 0
drwxr-xr-x@  6 kwak  staff  192 Mar 24 13:20 .
drwxr-xr-x  18 kwak  staff  576 Mar 24 11:57 ..
drwxr-xr-x@  9 kwak  staff  288 Mar 23 13:21 system-garden
drwxr-xr-x@  6 kwak  staff  192 Mar 24 13:20 tool-registry
drwxr-xr-x@ 11 kwak  staff  352 Mar 24 10:12 work-board
drwxr-xr-x@  7 kwak  staff  224 Mar 24 13:11 workflow-engine
exec
/bin/zsh -lc "sed -n '1,220p' plugins/workflow-engine/tsconfig.json" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
{
  "compilerOptions": {
    "target": "ES2023",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "dist",
    "rootDir": "src",
    "lib": ["ES2023", "DOM"],
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "declaration": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
codex
SDK/기존 플러그인 시그니처를 확인했고, 다음으로 `workflow-engine`의 `manifest/worker/ui/store`를 기준 템플릿으로 복제 가능한 부분과 KB 전용 로직을 분리해서 작성하겠습니다.
exec
/bin/zsh -lc "sed -n '1,200p' plugins/workflow-engine/src/constants.ts" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,260p' plugins/workflow-engine/src/manifest.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  JOB_KEYS,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from "./constants.js";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: "Workflow Engine",
  description:
    "DAG-based workflow engine — orchestrates multi-step agent workflows with dependency resolution, reconciliation, and failure policies",
  author: "InsightFlo",
  categories: ["automation"],
  capabilities: [
 succeeded in 0ms:
export const PLUGIN_ID = "insightflo.workflow-engine";
export const PLUGIN_VERSION = "0.1.0";
export const PAGE_ROUTE = "workflows";

export const SLOT_IDS = {
  page: "workflow-engine-page",
  dashboardWidget: "workflow-engine-dashboard-widget",
} as const;

export const EXPORT_NAMES = {
  page: "WorkflowPage",
  dashboardWidget: "WorkflowDashboardWidget",
} as const;

export const JOB_KEYS = {
  reconciler: "workflow-reconciler",
} as const;

export const ENTITY_TYPES = {
  workflowDefinition: "workflow-definition",
exec
/bin/zsh -lc "sed -n '1,240p' plugins/workflow-engine/src/index.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
export { default as manifest } from "./manifest.js";
export { default as worker } from "./worker.js";
exec
/bin/zsh -lc "sed -n '1,320p' plugins/workflow-engine/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEntityRecord,
  type PluginEvent,
  type PluginJobContext,
} from "@paperclipai/plugin-sdk";
import { JOB_KEYS, RUN_STATUSES, STEP_STATUSES } from "./constants.js";
import {
  getEscalationTarget,
  getNextSteps,
  getRetryInfo,
  type WorkflowStep,
} from "./dag-engine.js";
import {
  checkIdempotency,
  createWorkflowRun,
  createStepRun,
  findStepRunByIssueId,
exec
/bin/zsh -lc "sed -n '320,760p' plugins/workflow-engine/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
    }

    const stepRun = toWorkflowStepRunRecord(await createStepRun(ctx, companyId, {
      agentName: resolvedAgent.agentName,
      retryCount: 0,
      runId: workflowRun.id,
      status: STEP_STATUSES.backlog,
      stepId: stepDef.id,
    }));

    if (stepDef.dependsOn.length === 0 && stepDef.triggerOn !== "escalation") {
      pendingRootSteps.push({ stepDef, stepRun });
    }
  }

  const activatedStepIds: string[] = [];
  for (const pending of pendingRootSteps) {
    await activateBacklogStep(
      ctx,
      pending.stepRun,
exec
/bin/zsh -lc "sed -n '760,1180p' plugins/workflow-engine/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
}

async function runReconciler(ctx: PluginContext): Promise<void> {
  const modulePath = "./reconciler.js";

  try {
    const module = await import(modulePath) as ReconcilerModule;
    if (typeof module.reconcileStuckSteps !== "function") {
      ctx.logger.warn("Reconciler module does not export reconcileStuckSteps");
      return;
    }

    await module.reconcileStuckSteps(ctx);
  } catch (error) {
    ctx.logger.warn("Failed to run workflow reconciler", {
      error: summarizeError(error),
    });
  }
}

exec
/bin/zsh -lc "sed -n '1,360p' plugins/workflow-engine/src/workflow-store.ts" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,360p' plugins/workflow-engine/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";

import { ENTITY_TYPES } from "./constants.js";
import type { WorkflowStep } from "./dag-engine.js";

export interface WorkflowDefinition {
  name: string;
  description: string;
  companyId: string;
  status: "active" | "paused" | "archived";
  steps: WorkflowStep[];
  timeoutMinutes?: number;
  maxConcurrentRuns?: number;
}

export interface WorkflowRun {
  workflowId: string;
  workflowName: string;
  companyId: string;
  status: "running" | "completed" | "failed" | "aborted" | "timed-out";
 succeeded in 0ms:
import {
  useHostContext,
  usePluginData,
  type PluginPageProps,
  type PluginWidgetProps,
} from "@paperclipai/plugin-sdk/ui";
import { type CSSProperties, type JSX } from "react";
import { PLUGIN_ID } from "../constants.js";

type WorkflowOverviewData = {
  workflows: Array<{
    id: string;
    name: string;
    description: string;
    status: string;
    steps: Array<{ id: string; title: string; dependsOn: string[] }>;
  }>;
  activeRuns: Array<{
    id: string;
    workflowName: string;
exec
/bin/zsh -lc "sed -n '360,760p' plugins/workflow-engine/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
      <section style={sectionStyle}>
        <div style={{ display: "grid", gap: "4px" }}>
          <h2 style={sectionTitleStyle}>Active Runs</h2>
          <p style={mutedTextStyle}>Currently running or unresolved workflow executions.</p>
        </div>
        <ActiveRunsTable activeRuns={data.activeRuns} />
      </section>
    </div>
  );
}

export function WorkflowDashboardWidget(props: PluginWidgetProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context.companyId ?? "";
  const overview = useWorkflowOverview(companyId);

  if (overview.loading) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={widgetStyle}>
        <h2 style={widgetTitleStyle}>Workflows</h2>
codex
`workflow-engine` 코드 패턴 확인 완료했습니다. 이제 SDK의 이벤트/데이터/UI 훅 타입을 점검한 뒤 동일 패턴으로 `knowledge-base`의 `store/worker/ui`를 일괄 생성하겠습니다.
exec
/bin/zsh -lc "sed -n '1,220p' plugins/workflow-engine/scripts/build-ui.mjs" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,280p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/types.ts" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,320p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/ui/hooks.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import esbuild from "esbuild";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, "..");

await esbuild.build({
  entryPoints: [path.join(packageRoot, "src/ui/index.tsx")],
  outfile: path.join(packageRoot, "dist/ui/index.js"),
  bundle: true,
  format: "esm",
  platform: "browser",
  target: ["es2022"],
  sourcemap: true,
  external: [
    "react",
    "react-dom",
    "react/jsx-runtime",
 succeeded in 0ms:
import type {
  PluginDataResult,
  PluginActionFn,
  PluginHostContext,
  PluginStreamResult,
  PluginToastFn,
} from "./types.js";
import { getSdkUiRuntimeValue } from "./runtime.js";

// ---------------------------------------------------------------------------
// usePluginData
// ---------------------------------------------------------------------------

/**
 * Fetch data from the plugin worker's registered `getData` handler.
 *
 * Calls `ctx.data.register(key, handler)` in the worker and returns the
 * result as reactive state. Re-fetches when `params` changes.
 *
 * @template T The expected shape of the returned data
 succeeded in 0ms:
/**
 * Core types for the Paperclip plugin worker-side SDK.
 *
 * These types define the stable public API surface that plugin workers import
 * from `@paperclipai/plugin-sdk`.  The host provides a concrete implementation
 * of `PluginContext` to the plugin at initialisation time.
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  PaperclipPluginManifestV1,
  PluginStateScopeKind,
  PluginEventType,
  PluginToolDeclaration,
  PluginLauncherDeclaration,
  Company,
  Project,
  Issue,
exec
/bin/zsh -lc "sed -n '1,280p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/ui/types.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/**
 * Paperclip plugin UI SDK — types for plugin frontend components.
 *
 * Plugin UI bundles import from `@paperclipai/plugin-sdk/ui`.  This subpath
 * provides the bridge hooks, component prop interfaces, and error types that
 * plugin React components use to communicate with the host.
 *
 * Plugin UI bundles are loaded as ES modules into designated extension slots.
 * All communication with the plugin worker goes through the host bridge — plugin
 * components must NOT access host internals or call host APIs directly.
 *
 * @see PLUGIN_SPEC.md §19 — UI Extension Model
 * @see PLUGIN_SPEC.md §19.0.1 — Plugin UI SDK
 * @see PLUGIN_SPEC.md §29.2 — SDK Versioning
 */

import type {
  PluginBridgeErrorCode,
  PluginLauncherBounds,
  PluginLauncherRenderEnvironment,
exec
/bin/zsh -lc "sed -n '280,760p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/types.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
 * filesystem paths for file browsing, git, terminal, and process operations.
 *
 * @see PLUGIN_SPEC.md §7 — Project Workspaces
 * @see PLUGIN_SPEC.md §20 — Local Tooling
 */
export interface PluginWorkspace {
  /** UUID primary key. */
  id: string;
  /** UUID of the parent project. */
  projectId: string;
  /** Display name for this workspace. */
  name: string;
  /** Absolute filesystem path to the workspace directory. */
  path: string;
  /** Whether this is the project's primary workspace. */
  isPrimary: boolean;
  /** ISO 8601 creation timestamp. */
  createdAt: string;
  /** ISO 8601 last-updated timestamp. */
  updatedAt: string;
exec
/bin/zsh -lc "rg -n \"interface PluginContext|data:|events:|agents:|issue\\.comments|comments\" /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/types.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
225:  data: Record<string, unknown>;
249:  data: Record<string, unknown>;
849: * `ctx.issues` — read and mutate issues plus comments.
855: * - `issue.comments.read` for `listComments`
856: * - `issue.comments.create` for `createComment`
1097:export interface PluginContext {
1105:  events: PluginEventsClient;
1134:  /** Read and write issues, comments, and documents. Requires issue capabilities. */
1138:  agents: PluginAgentsClient;
1144:  data: PluginDataClient;
exec
/bin/zsh -lc "sed -n '760,1260p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/types.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
   */
  write(name: string, value: number, tags?: Record<string, string>): Promise<void>;
}

/**
 * `ctx.companies` — read company metadata.
 *
 * Requires `companies.read` capability.
 */
export interface PluginCompaniesClient {
  /**
   * List companies visible to this plugin.
   */
  list(input?: { limit?: number; offset?: number }): Promise<Company[]>;

  /**
   * Get one company by ID.
   */
  get(companyId: string): Promise<Company | null>;
}
exec
/bin/zsh -lc "sed -n '1,260p' plugins/work-board/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,280p' plugins/work-board/src/manifest.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";

const PLUGIN_ID = "paperclipai.work-board";
const PLUGIN_VERSION = "0.1.0";
const PLUGIN_DISPLAY_NAME = "Work Board";
const PAGE_ROUTE = "work-board";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: PLUGIN_DISPLAY_NAME,
  description: "Area-based weekly work board for Alpha-Prime OS.",
  author: "Paperclip",
  categories: ["ui"],
  capabilities: [
    "issues.read",
    "ui.page.register",
    "ui.sidebar.register",
    "ui.dashboardWidget.register"
 succeeded in 0ms:
import { usePluginData, type PluginPageProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
import { useState, type CSSProperties } from "react";
import { PAGE_ROUTE, WORKSTREAMS } from "../constants.js";
import type { BoardIssueCard, WorkBoardSnapshot, WorkstreamSnapshot } from "../worker.js";

const pageStyle: CSSProperties = {
  display: "grid",
  gap: "24px",
  padding: "24px",
};

const heroStyle: CSSProperties = {
  display: "grid",
  gap: "16px",
  padding: "24px",
  borderRadius: "24px",
  border: "1px solid color-mix(in srgb, var(--border, #d4d4d8) 85%, transparent)",
  background: [
    "radial-gradient(circle at top left, color-mix(in srgb, var(--accent, #7dd3fc) 30%, transparent) 0%, transparent 42%)",
    "linear-gradient(145deg, color-mix(in srgb, var(--card, #ffffff) 96%, transparent), color-mix(in srgb, var(--background, #f8fafc) 92%, transparent))",
exec
/bin/zsh -lc "sed -n '1,280p' plugins/tool-registry/src/manifest.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
  TOOL_NAMES,
} from "./constants.js";

const capabilities = [
  "events.subscribe",
  "issues.read",
  "issues.create",
  "issue.comments.create",
  "agents.read",
  "agents.pause",
  "companies.read",
  "plugin.state.read",
  "plugin.state.write",
exec
/bin/zsh -lc 'rg -n "PluginSidebarProps|Sidebar" plugins/work-board/src/ui/index.tsx plugins/system-garden/src/ui/index.tsx plugins/tool-registry/src/ui/index.tsx' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
plugins/work-board/src/ui/index.tsx:1:import { usePluginData, type PluginPageProps, type PluginSidebarProps, type PluginWidgetProps } from "@paperclipai/plugin-sdk/ui";
plugins/work-board/src/ui/index.tsx:424:export function WorkBoardSidebarLink({ context }: PluginSidebarProps) {
plugins/system-garden/src/ui/index.tsx:1:import { usePluginData, type PluginPageProps, type PluginSidebarProps } from "@paperclipai/plugin-sdk/ui";
plugins/system-garden/src/ui/index.tsx:526:export function SystemGardenSidebarLink({ context }: PluginSidebarProps) {
exec
/bin/zsh -lc "sed -n '500,620p' plugins/system-garden/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '410,500p' plugins/work-board/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
          <aside
            style={{
              borderRadius: "14px",
              border: "1px solid color-mix(in srgb, var(--border, #334155) 76%, transparent)",
              background: "color-mix(in srgb, var(--card, #0b1220) 92%, transparent)",
              padding: "12px",
            }}
          >
            <AgentDetailPanel selectedNode={selectedNode} detail={detail.data ?? null} loading={detail.loading} />
          </aside>
        </div>
      </section>

      <section style={{ ...panelStyle, padding: "14px", display: "grid", gap: "12px" }}>
        <h2 style={panelTitleStyle}>Health</h2>
        <HealthCardRow cards={snapshot.data.cards} />
      </section>

      <section style={{ ...panelStyle, padding: "14px", display: "grid", gap: "12px" }}>
        <h2 style={panelTitleStyle}>Questions</h2>
 succeeded in 0ms:

  if (board.loading) {
    return <div style={pageStyle}>업무 보드를 불러오는 중...</div>;
  }
  if (board.error) {
    return <div style={pageStyle}>업무 보드를 불러오지 못했다: {board.error.message}</div>;
  }
  if (!board.data) {
    return <div style={pageStyle}>표시할 데이터가 없다.</div>;
  }

  return <BoardContent context={context} data={board.data} onRefresh={board.refresh} loading={board.loading} />;
}

export function WorkBoardSidebarLink({ context }: PluginSidebarProps) {
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
exec
/bin/zsh -lc "sed -n '1,320p' plugins/work-board/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_COMPANY_ID,
  ISSUE_STATUS_LABELS,
  PLUGIN_DISPLAY_NAME,
  PRIORITY_WEIGHTS,
  WORKSTREAMS,
  type WorkstreamDefinition,
} from "./constants.js";

type BoardBucketKey = "overdueLastWeek" | "todo" | "inProgress" | "doneThisWeek";
type WorkstreamTone = "neutral" | "attention" | "progress" | "complete";
type MatchType = "label" | "keyword";

type IssueRecord = Awaited<ReturnType<PluginContext["issues"]["list"]>>[number];

export type BoardIssueCard = {
  id: string;
  identifier: string | null;
  title: string;
exec
/bin/zsh -lc "rg -n \"definePlugin|ctx.data|register\\(\" plugins/work-board/src/worker.ts | head -n 40" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
1:import { definePlugin, runWorker, type PluginContext } from "@paperclipai/plugin-sdk";
463:const plugin = definePlugin({
465:    ctx.data.register("work-board-overview", async (params) => {
exec
/bin/zsh -lc "sed -n '448,560p' plugins/work-board/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
      start: weekStart.toISOString(),
      end: weekEnd.toISOString(),
      label: formatWeekRangeLabel(weekStart, weekEnd),
    },
    totals,
    workstreams,
    unmatched: unmatchedSorted,
  };
}

async function loadBoardSnapshot(ctx: PluginContext, companyId: string): Promise<WorkBoardSnapshot> {
  const issues = await ctx.issues.list({ companyId, limit: 500, offset: 0 });
  return buildWorkBoardSnapshot(issues, { companyId });
}

const plugin = definePlugin({
  async setup(ctx) {
    ctx.data.register("work-board-overview", async (params) => {
      const companyId = getCompanyId(params);
      return await loadBoardSnapshot(ctx, companyId);
codex
다음 단계로 `knowledge-base` 파일들을 실제 생성하겠습니다. `manifest`는 `page + sidebar` 슬롯, `worker`는 `agent.run.started` 주입 + `ctx.data` CRUD 핸들러, `kb-store`는 전부 `ctx.entities` 기반 CRUD로 작성합니다.
exec
/bin/zsh -lc "sed -n '1,280p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/index.ts" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '1,260p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/src/define-plugin.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/**
 * `@paperclipai/plugin-sdk` — Paperclip plugin worker-side SDK.
 *
 * This is the main entrypoint for plugin worker code.  For plugin UI bundles,
 * import from `@paperclipai/plugin-sdk/ui` instead.
 *
 * @example
 * ```ts
 * // Plugin worker entrypoint (dist/worker.ts)
 * import { definePlugin, runWorker, z } from "@paperclipai/plugin-sdk";
 *
 * const plugin = definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Plugin starting up");
 *
 *     ctx.events.on("issue.created", async (event) => {
 *       ctx.logger.info("Issue created", { issueId: event.entityId });
 *     });
 *
 *     ctx.jobs.register("full-sync", async (job) => {
 succeeded in 0ms:
/**
 * `definePlugin` — the top-level helper for authoring a Paperclip plugin.
 *
 * Plugin authors call `definePlugin()` and export the result as the default
 * export from their worker entrypoint. The host imports the worker module,
 * calls `setup()` with a `PluginContext`, and from that point the plugin
 * responds to events, jobs, webhooks, and UI requests through the context.
 *
 * @see PLUGIN_SPEC.md §14.1 — Example SDK Shape
 *
 * @example
 * ```ts
 * // dist/worker.ts
 * import { definePlugin } from "@paperclipai/plugin-sdk";
 *
 * export default definePlugin({
 *   async setup(ctx) {
 *     ctx.logger.info("Linear sync plugin starting");
 *
 *     // Subscribe to events
exec
/bin/zsh -lc "rg -n \"agent\\.run\\.started|agent.run.started\" -S plugins /Users/kwak/Projects/paperclip/paperclip-orginal | head -n 50" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
plugins/tool-registry/src/worker.ts:395:  ctx.logger.info("Injected allowed tool list on agent.run.started", {
plugins/tool-registry/src/worker.ts:841:    ctx.events.on("agent.run.started", async (event) => {
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts:85: *   `agent.run.started`).
/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/PLUGIN_SPEC.md:778:- `agent.run.started`
/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/ideas-from-opencode.md:1091:- `events.subscribe(agent.run.started)`
/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/ideas-from-opencode.md:1162:- `events.subscribe(agent.run.started)`
/Users/kwak/Projects/paperclip/paperclip-orginal/doc/plugins/ideas-from-opencode.md:1547:- `events.subscribe(agent.run.started)`
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md:122:| `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | run |
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/shared/src/constants.ts:664:  "agent.run.started",
codex
`agent.run.started` 주입 로직은 `tool-registry`에 유사 패턴이 있어 해당 구현을 참고해 정확히 맞추겠습니다(특히 이벤트 payload/이슈 코멘트 주입 방식).
exec
/bin/zsh -lc "sed -n '320,520p' plugins/tool-registry/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "sed -n '760,960p' plugins/tool-registry/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

  const projectId = asString(payload.projectId)
    || asString(payload.project_id)
    || getNestedString(payload, "project", "id")
    || getNestedString(payload, "context", "projectId");

  const agentName = asString(payload.agentName)
    || asString(payload.agent_name)
    || getNestedString(payload, "agent", "name");

  const stdout = asString(payload.stdout) || asString(payload.stdoutExcerpt);
  const stderr = asString(payload.stderr) || asString(payload.stderrExcerpt);
  const log = asString(payload.log) || asString(payload.output);

  return {
    agentId,
    issueId,
    runId,
    projectId,
    agentName,
 succeeded in 0ms:
      patchData.env = patch.env;
    }

    if (patch.argsSchema && typeof patch.argsSchema === "object") {
      patchData.argsSchema = patch.argsSchema;
    }

    return await updateTool(ctx, companyId, toolName, {
      ...(patchData as Partial<{
        command: string;
        workingDirectory: string;
        env: Record<string, string>;
        requiresApproval: boolean;
        description: string;
        argsSchema: Record<string, unknown>;
      }>),
    });
  });

  ctx.actions.register(ACTION_KEYS.deleteTool, async (rawParams) => {
exec
/bin/zsh -lc "sed -n '1,240p' plugins/tool-registry/src/tool-store.ts" in /Users/kwak/Projects/paperclip/paperclip-addon exited 1 in 0ms:
sed: plugins/tool-registry/src/tool-store.ts: No such file or directory
exec
/bin/zsh -lc 'find plugins/tool-registry/src -maxdepth 2 -type f | sort' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
plugins/tool-registry/src/audit.ts
plugins/tool-registry/src/constants.ts
plugins/tool-registry/src/index.ts
plugins/tool-registry/src/manifest.ts
plugins/tool-registry/src/tool-config.ts
plugins/tool-registry/src/ui/index.tsx
plugins/tool-registry/src/worker.ts
exec
/bin/zsh -lc "sed -n '1,360p' plugins/tool-registry/src/tool-config.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import { ENTITY_TYPES } from "./constants.js";

export type JsonRecord = Record<string, unknown>;

type PluginEntityScopeKind = "instance" | "company" | "project" | "project_workspace" | "agent" | "issue" | "goal" | "run";

type EntityQuery = Parameters<PluginContext["entities"]["list"]>[0];

type EntityCreateInput = {
  entityType: string;
  scopeKind: PluginEntityScopeKind;
  scopeId?: string;
  externalId?: string;
  title?: string;
  status?: string;
  data: JsonRecord;
};

type EntityUpdateInput = {
exec
/bin/zsh -lc "rg -n \"emit\\(\\s*\\\"agent.run.started\\\"|agent.run.started\" /Users/kwak/Projects/paperclip/paperclip-orginal/server /Users/kwak/Projects/paperclip/paperclip-orginal/packages -S | head -n 80" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/shared/src/constants.ts:664:  "agent.run.started",
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts:85: *   `agent.run.started`).
/Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md:122:| `agent.run.started`, `agent.run.finished`, `agent.run.failed`, `agent.run.cancelled` | run |
exec
/bin/zsh -lc 'rg -n "agent.run.finished|agent.run.failed|run.started" /Users/kwak/Projects/paperclip/paperclip-orginal/server/src -S | head -n 120' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-job-store.ts:306:     * @param lastRunAt - When the last run started
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-job-scheduler.ts:665:          durationMs: run.startedAt
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-job-scheduler.ts:666:            ? Date.now() - run.startedAt.getTime()
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/heartbeat.ts:1561:        startedAt: run.startedAt ?? claimedAt,
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/heartbeat.ts:2218:      const startedAt = run.startedAt ?? new Date();
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/heartbeat.ts:2256:        message: "run started",
/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/plugin-event-bus.ts:85: *   `agent.run.started`).
exec
/bin/zsh -lc "sed -n '80,180p' /Users/kwak/Projects/paperclip/paperclip-orginal/packages/plugins/sdk/README.md" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
    });
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
```

**Note:** `runWorker(plugin, import.meta.url)` must be called so that when the host runs your worker (e.g. `node dist/worker.js`), the RPC host starts and the process stays alive. When the file is imported (e.g. for tests), the main-module check prevents the host from starting.

### Worker lifecycle and context

**Lifecycle (definePlugin):**

| Hook | Purpose |
|------|--------|
| `setup(ctx)` | **Required.** Called once at startup. Register event handlers, jobs, data/actions/tools, etc. |
| `onHealth?()` | Optional. Return `{ status, message?, details? }` for health dashboard. |
| `onConfigChanged?(newConfig)` | Optional. Apply new config without restart; if omitted, host restarts worker. |
| `onShutdown?()` | Optional. Clean up before process exit (limited time window). |
exec
/bin/zsh -lc "if [ -f package.json ]; then cat package.json; else echo 'no package.json at root'; fi" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
no package.json at root
exec
/bin/zsh -lc 'ls -la plugins/workflow-engine' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
total 16
drwxr-xr-x@  7 kwak  staff  224 Mar 24 13:11 .
drwxr-xr-x@  6 kwak  staff  192 Mar 24 13:20 ..
drwxr-xr-x@ 19 kwak  staff  608 Mar 24 13:11 dist
-rw-r--r--@  1 kwak  staff  981 Mar 24 12:01 package.json
drwxr-xr-x@  3 kwak  staff   96 Mar 24 12:01 scripts
drwxr-xr-x@ 11 kwak  staff  352 Mar 24 13:08 src
-rw-r--r--@  1 kwak  staff  413 Mar 24 12:01 tsconfig.json
codex
이제 실제 파일 생성을 시작합니다. `kb-store.ts`를 먼저 만들어 엔티티 CRUD/호환 레이어를 고정하고, 그 위에 `worker.ts` 이벤트 주입/핸들러, 마지막으로 `ui/index.tsx`를 연결하겠습니다.
exec
/bin/zsh -lc 'mkdir -p plugins/knowledge-base/src/ui plugins/knowledge-base/scripts' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "cat > plugins/knowledge-base/package.json <<'EOF'
{
  \"name\": \"@insightflo/paperclip-knowledge-base\",
  \"version\": \"0.1.0\",
  \"description\": \"Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access\",
  \"type\": \"module\",
  \"private\": true,
  \"exports\": {
    \".\": \"./src/index.ts\"
  },
  \"paperclipPlugin\": {
    \"manifest\": \"./dist/manifest.js\",
    \"worker\": \"./dist/worker.js\",
    \"ui\": \"./dist/ui/\"
  },
  \"scripts\": {
    \"build\": \"tsc && node ./scripts/build-ui.mjs\",
    \"clean\": \"rm -rf dist\",
    \"typecheck\": \"tsc --noEmit\"
  },
  \"dependencies\": {
    \"@paperclipai/plugin-sdk\": \"workspace:*\",
    \"@paperclipai/shared\": \"workspace:*\"
  },
  \"devDependencies\": {
    \"esbuild\": \""'^0.27.3",
    "@types/node": "''^24.6.0",
    "@types/react": "''^19.0.8",
    "@types/react-dom": "''^19.0.3",
    "react": "''^19.0.0",
    "react-dom": "''^19.0.0",
    "typescript": "''^5.7.3"
  },
  "peerDependencies": {
    "react": ">=18"
  }
}
EOF' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

codex
패키지/빌드 파일 생성을 진행 중입니다. 방금 생성한 `package.json`은 셸 인용 이슈 가능성이 있어 바로 검증하고 문제 있으면 즉시 수정하겠습니다.
exec
/bin/zsh -lc 'cat plugins/knowledge-base/package.json' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
{
  "name": "@insightflo/paperclip-knowledge-base",
  "version": "0.1.0",
  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
  "type": "module",
  "private": true,
  "exports": {
    ".": "./src/index.ts"
  },
  "paperclipPlugin": {
    "manifest": "./dist/manifest.js",
    "worker": "./dist/worker.js",
    "ui": "./dist/ui/"
  },
  "scripts": {
    "build": "tsc && node ./scripts/build-ui.mjs",
    "clean": "rm -rf dist",
    "typecheck": "tsc --noEmit"
  },
  "dependencies": {
exec
/bin/zsh -lc "cat > plugins/knowledge-base/scripts/build-ui.mjs <<'EOF'
import esbuild from \"esbuild\";
import path from \"node:path\";
import { fileURLToPath } from \"node:url\";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const packageRoot = path.resolve(__dirname, \"..\");

await esbuild.build({
  entryPoints: [path.join(packageRoot, \"src/ui/index.tsx\")],
  outfile: path.join(packageRoot, \"dist/ui/index.js\"),
  bundle: true,
  format: \"esm\",
  platform: \"browser\",
  target: [\"es2022\"],
  sourcemap: true,
  external: [
    \"react\",
    \"react-dom\",
    \"react/jsx-runtime\",
    \"@paperclipai/plugin-sdk/ui\"
  ],
  logLevel: \"info\"
});
EOF" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "cat > plugins/knowledge-base/tsconfig.json <<'EOF'
{
  \"compilerOptions\": {
    \"target\": \"ES2023\",
    \"module\": \"NodeNext\",
    \"moduleResolution\": \"NodeNext\",
    \"outDir\": \"dist\",
    \"rootDir\": \"src\",
    \"lib\": [\"ES2023\", \"DOM\"],
    \"jsx\": \"react-jsx\",
    \"strict\": true,
    \"esModuleInterop\": true,
    \"declaration\": true,
    \"skipLibCheck\": true,
    \"forceConsistentCasingInFileNames\": true,
    \"resolveJsonModule\": true
  },
  \"include\": [\"src\"]
}
EOF" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

 succeeded in 0ms:

exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/constants.ts <<'EOF'
export const PLUGIN_ID = \"insightflo.knowledge-base\";
export const PLUGIN_VERSION = \"0.1.0\";
export const PAGE_ROUTE = \"knowledge-base\";

export const SLOT_IDS = {
  page: \"knowledge-base-page\",
  sidebar: \"knowledge-base-sidebar\",
} as const;

export const EXPORT_NAMES = {
  page: \"KnowledgeBasePage\",
  sidebar: \"KnowledgeBaseSidebarLink\",
} as const;

export const ENTITY_TYPES = {
  knowledgeBase: \"knowledge-base\",
  agentKbGrant: \"agent-kb-grant\",
} as const;

export const KB_TYPES = {
  static: \"static\",
  rag: \"rag\",
  ontology: \"ontology\",
} as const;

export const DEFAULT_MAX_TOKEN_BUDGET = 4096;

export const DATA_KEYS = {
  overview: \"knowledge-base.overview\",
  kbList: \"knowledge-base.list\",
  kbGet: \"knowledge-base.get\",
  grantList: \"knowledge-base.grant.list\",
  agentList: \"knowledge-base.agent.list\",
  kbCreate: \"knowledge-base.create\",
  kbUpdate: \"knowledge-base.update\",
  kbDelete: \"knowledge-base.delete\",
  grantCreate: \"knowledge-base.grant.create\",
  grantDelete: \"knowledge-base.grant.delete\",
} as const;

export const ACTION_KEYS = {
  kbCreate: DATA_KEYS.kbCreate,
  kbUpdate: DATA_KEYS.kbUpdate,
  kbDelete: DATA_KEYS.kbDelete,
  grantCreate: DATA_KEYS.grantCreate,
  grantDelete: DATA_KEYS.grantDelete,
} as const;
EOF" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/index.ts <<'EOF'
export { default as manifest } from \"./manifest.js\";
export { default as worker } from \"./worker.js\";
EOF" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/manifest.ts <<'EOF'
import type { PaperclipPluginManifestV1 } from \"@paperclipai/plugin-sdk\";
import {
  EXPORT_NAMES,
  PAGE_ROUTE,
  PLUGIN_ID,
  PLUGIN_VERSION,
  SLOT_IDS,
} from \"./constants.js\";

const manifest: PaperclipPluginManifestV1 = {
  id: PLUGIN_ID,
  apiVersion: 1,
  version: PLUGIN_VERSION,
  displayName: \"Knowledge Base\",
  description: \"Registers company knowledge sources and grants agent-level access at run time.\",
  author: \"InsightFlo\",
  categories: [\"knowledge\", \"automation\"],
  capabilities: [
    \"events.subscribe\",
    \"agents.read\",
    \"issue.comments.create\",
    \"ui.page.register\",
    \"ui.sidebar.register\",
  ],
  entrypoints: {
    worker: \"./dist/worker.js\",
    ui: \"./dist/ui\",
  },
  ui: {
    slots: [
      {
        type: \"page\",
        id: SLOT_IDS.page,
        displayName: \"Knowledge Base\",
        exportName: EXPORT_NAMES.page,
        routePath: PAGE_ROUTE,
      },
      {
        type: \"sidebar\",
        id: SLOT_IDS.sidebar,
        displayName: \"Knowledge Base\",
        exportName: EXPORT_NAMES.sidebar,
      },
    ],
  },
};

export default manifest;
EOF" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/kb-store.ts <<'EOF'
import type { PluginContext, PluginEntityRecord } from \"@paperclipai/plugin-sdk\";
import {
  DEFAULT_MAX_TOKEN_BUDGET,
  ENTITY_TYPES,
  KB_TYPES,
} from \"./constants.js\";

type JsonRecord = Record<string, unknown>;

type PluginEntityScopeKind =
  | \"instance\"
  | \"company\"
  | \"project\"
  | \"project_workspace\"
  | \"agent\"
  | \"issue\"
  | \"goal\"
  | \"run\";

type EntityQuery = Parameters<PluginContext[\"entities\"][\"list\"]>[0];

type EntityCreateInput = {
  entityType: string;
  scopeKind: PluginEntityScopeKind;
  scopeId?: string;
  externalId?: string;
  title?: string;
  status?: string;
  data: JsonRecord;
};

type EntityUpdateInput = {
  externalId?: string;
  title?: string;
  status?: string;
  data?: JsonRecord;
};

type EntitiesCompatClient = PluginContext[\"entities\"] & {
  get?: (id: string) => Promise<PluginEntityRecord | null>;
  create?: (input: EntityCreateInput) => Promise<PluginEntityRecord>;
  update?: (id: string, patch: EntityUpdateInput) => Promise<PluginEntityRecord>;
  delete?: (id: string) => Promise<void>;
  upsert?: (input: EntityCreateInput) => Promise<PluginEntityRecord>;
};

export type KnowledgeBaseType = \"static\" | \"rag\" | \"ontology\";

export interface KnowledgeBaseData {
  name: string;
  type: KnowledgeBaseType;
  description?: string;
  companyId: string;
  maxTokenBudget: number;
  staticConfig?: {
    content: string;
  };
  ragConfig?: {
    mcpServerUrl?: string;
    topK?: number;
  };
  ontologyConfig?: {
    kgPath?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export interface AgentKBGrantData {
  agentName: string;
  kbName: string;
  grantedBy: string;
  grantedAt: string;
}

export type KnowledgeBaseRecord = Omit<PluginEntityRecord, \"data\"> & {
  data: KnowledgeBaseData;
};

export type AgentKBGrantRecord = Omit<PluginEntityRecord, \"data\"> & {
  data: AgentKBGrantData;
};

function entities(ctx: PluginContext): EntitiesCompatClient {
  return ctx.entities as unknown as EntitiesCompatClient;
}

function asRecord(value: unknown): JsonRecord {
  if ("'!value || typeof value !== "object") {
    return {};
  }

  return value as JsonRecord;
}

function asNonEmptyString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  const normalized = asNonEmptyString(value);
  if (!normalized) {
    throw new Error(`${fieldName} is required`);
  }

  return normalized;
}

function normalizeKnowledgeBaseType(value: unknown): KnowledgeBaseType {
  const normalized = asNonEmptyString(value).toLowerCase();

  if (normalized === KB_TYPES.static || normalized === KB_TYPES.rag || normalized === KB_TYPES.ontology) {
    return normalized as KnowledgeBaseType;
  }

  return KB_TYPES.static;
}

function normalizeMaxTokenBudget(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return DEFAULT_MAX_TOKEN_BUDGET;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return DEFAULT_MAX_TOKEN_BUDGET;
  }

  return rounded;
}

function normalizeStaticConfig(value: unknown): KnowledgeBaseData["staticConfig"] {
  const config = asRecord(value);
  return {
    content: typeof config.content === "string" ? config.content : "",
  };
}

function normalizeRagConfig(value: unknown): KnowledgeBaseData["ragConfig"] {
  const config = asRecord(value);
  const mcpServerUrl = asNonEmptyString(config.mcpServerUrl);

  let topK: number | undefined;
  if (typeof config.topK === "number" && Number.isFinite(config.topK) && config.topK > 0) {
    topK = Math.floor(config.topK);
  }

  return {
    mcpServerUrl: mcpServerUrl || undefined,
    topK,
  };
}

function normalizeOntologyConfig(value: unknown): KnowledgeBaseData["ontologyConfig"] {
  const config = asRecord(value);
  const kgPath = asNonEmptyString(config.kgPath);

  return {
    kgPath: kgPath || undefined,
  };
}

function toKnowledgeBaseData(
  input: Partial<KnowledgeBaseData>,
  nowIso: string,
  fallback?: KnowledgeBaseData,
): KnowledgeBaseData {
  const type = normalizeKnowledgeBaseType(input.type ?? fallback?.type);
  const name = normalizeRequiredString(input.name ?? fallback?.name, "name");
  const companyId = normalizeRequiredString(input.companyId ?? fallback?.companyId, "companyId");
  const description = asNonEmptyString(input.description ?? fallback?.description);
  const maxTokenBudget = normalizeMaxTokenBudget(input.maxTokenBudget ?? fallback?.maxTokenBudget);
  const createdAt = asNonEmptyString(input.createdAt ?? fallback?.createdAt) || nowIso;
  const updatedAt = asNonEmptyString(input.updatedAt) || nowIso;

  const staticConfig = type === KB_TYPES.static
    ? normalizeStaticConfig(input.staticConfig ?? fallback?.staticConfig)
    : normalizeStaticConfig(input.staticConfig ?? fallback?.staticConfig ?? {});

  const ragConfig = normalizeRagConfig(input.ragConfig ?? fallback?.ragConfig);
  const ontologyConfig = normalizeOntologyConfig(input.ontologyConfig ?? fallback?.ontologyConfig);

  return {
    name,
    type,
    description: description || undefined,
    companyId,
    maxTokenBudget,
    staticConfig: type === KB_TYPES.static ? staticConfig : undefined,
    ragConfig: type === KB_TYPES.rag ? ragConfig : undefined,
    ontologyConfig: type === KB_TYPES.ontology ? ontologyConfig : undefined,
    createdAt,
    updatedAt,
  };
}

function toGrantData(
  input: Partial<AgentKBGrantData>,
  nowIso: string,
  fallback?: AgentKBGrantData,
): AgentKBGrantData {
  return {
    agentName: normalizeRequiredString(input.agentName ?? fallback?.agentName, "agentName"),
    kbName: normalizeRequiredString(input.kbName ?? fallback?.kbName, "kbName"),
    grantedBy: normalizeRequiredString(input.grantedBy ?? fallback?.grantedBy, "grantedBy"),
    grantedAt: asNonEmptyString(input.grantedAt ?? fallback?.grantedAt) || nowIso,
  };
}

function asDataRecord<T extends object>(value: T): JsonRecord {
  return value as unknown as JsonRecord;
}

function queryWithOptionalId(query: EntityQuery, id?: string): EntityQuery {
  if (!id) {
    return query;
  }

  return {
    ...(query as JsonRecord),
    id,
  } as EntityQuery;
}

async function listByType(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const listed = await entities(ctx).list({
    entityType,
    scopeKind: "company",
    scopeId: companyId,
    limit: 1000,
  } as EntityQuery);

  return listed
    .filter((record: PluginEntityRecord) => record.entityType === entityType)
    .filter((record: PluginEntityRecord) => asRecord(record.data).__deleted !== true);
}

async function findByExternalId(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
  externalId: string,
): Promise<PluginEntityRecord | null> {
  const listClient = entities(ctx);

  const directMatches = await listClient.list({
    entityType,
    scopeKind: "company",
    scopeId: companyId,
    externalId,
    limit: 20,
  } as EntityQuery);

  const direct = directMatches.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
  if (direct) {
    return direct;
  }

  const fallback = await listByType(ctx, entityType, companyId);
  return fallback.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
}

async function getById(
  ctx: PluginContext,
  entityType: string,
  id: string,
): Promise<PluginEntityRecord | null> {
  const listClient = entities(ctx);
  const withId = await listClient.list(queryWithOptionalId({ entityType, limit: 10 } as EntityQuery, id));
  const fromList = withId.find(
    (record: PluginEntityRecord) => record.id === id && record.entityType === entityType,
  ) ?? null;

  if (fromList) {
    return fromList;
  }

  if (typeof listClient.get === "function") {
    const viaGet = await listClient.get(id);
    if (viaGet && viaGet.entityType === entityType) {
      return viaGet;
    }
  }

  return null;
}

async function createEntity(ctx: PluginContext, input: EntityCreateInput): Promise<PluginEntityRecord> {
  const client = entities(ctx);

  if (typeof client.create === "function") {
    return await client.create(input);
  }

  if (typeof client.upsert === "function") {
    return await client.upsert(input);
  }

  throw new Error("ctx.entities.create/upsert is not available on this host runtime");
}

async function updateEntity(
  ctx: PluginContext,
  id: string,
  patch: EntityUpdateInput,
): Promise<PluginEntityRecord> {
  const client = entities(ctx);

  if (typeof client.update === "function") {
    return await client.update(id, patch);
  }

  if (typeof client.get === "function" && typeof client.upsert === "function") {
    const current = await client.get(id);
    if (!current) {
      throw new Error(`Entity not found: ${id}`);
    }

    return await client.upsert({
      entityType: current.entityType,
      scopeKind: current.scopeKind as PluginEntityScopeKind,
      scopeId: current.scopeId ?? undefined,
      externalId: patch.externalId ?? current.externalId ?? undefined,
      title: patch.title ?? current.title ?? undefined,
      status: patch.status ?? current.status ?? undefined,
      data: patch.data ?? asRecord(current.data),
    });
  }

  throw new Error("ctx.entities.update is not available on this host runtime");
}

async function deleteEntity(ctx: PluginContext, id: string): Promise<void> {
  const client = entities(ctx);

  if (typeof client.delete === "function") {
    await client.delete(id);
    return;
  }

  if (typeof client.get === "function" && typeof client.update === "function") {
    const current = await client.get(id);
    if (!current) {
      return;
    }

    await client.update(id, {
      status: "deleted",
      data: {
        ...asRecord(current.data),
        __deleted: true,
        deletedAt: new Date().toISOString(),
      },
    });
    return;
  }

  throw new Error("ctx.entities.delete is not available on this host runtime");
}

function toKnowledgeBaseRecord(record: PluginEntityRecord): KnowledgeBaseRecord {
  return {
    ...record,
    data: toKnowledgeBaseData(asRecord(record.data) as Partial<KnowledgeBaseData>, record.updatedAt),
  };
}

function toGrantRecord(record: PluginEntityRecord): AgentKBGrantRecord {
  return {
    ...record,
    data: toGrantData(asRecord(record.data) as Partial<AgentKBGrantData>, record.updatedAt),
  };
}

function normalizeGrantExternalId(agentName: string, kbName: string): string {
  return `${agentName}::${kbName}`;
}

async function resolveKnowledgeBaseRecord(
  ctx: PluginContext,
  companyId: string,
  kbNameOrId: string,
): Promise<KnowledgeBaseRecord | null> {
  const trimmed = asNonEmptyString(kbNameOrId);
  if (!trimmed) {
    return null;
  }

  const byId = await getById(ctx, ENTITY_TYPES.knowledgeBase, trimmed);
  if (byId) {
    const typed = toKnowledgeBaseRecord(byId);
    if (typed.data.companyId === companyId) {
      return typed;
    }
  }

  const byName = await findByExternalId(ctx, ENTITY_TYPES.knowledgeBase, companyId, trimmed);
  return byName ? toKnowledgeBaseRecord(byName) : null;
}

export async function listKnowledgeBases(
  ctx: PluginContext,
  companyId: string,
): Promise<KnowledgeBaseRecord[]> {
  const listed = await listByType(ctx, ENTITY_TYPES.knowledgeBase, companyId);

  return listed
    .map(toKnowledgeBaseRecord)
    .sort((left, right) => left.data.name.localeCompare(right.data.name));
}

export async function getKnowledgeBaseByName(
  ctx: PluginContext,
  companyId: string,
  kbName: string,
): Promise<KnowledgeBaseRecord | null> {
  const normalizedName = asNonEmptyString(kbName);
  if (!normalizedName) {
    return null;
  }

  const found = await findByExternalId(ctx, ENTITY_TYPES.knowledgeBase, companyId, normalizedName);
  return found ? toKnowledgeBaseRecord(found) : null;
}

export async function getKnowledgeBaseById(
  ctx: PluginContext,
  id: string,
): Promise<KnowledgeBaseRecord | null> {
  const found = await getById(ctx, ENTITY_TYPES.knowledgeBase, asNonEmptyString(id));
  return found ? toKnowledgeBaseRecord(found) : null;
}

export async function upsertKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  input: Partial<KnowledgeBaseData> & { name: string; type?: KnowledgeBaseType },
): Promise<KnowledgeBaseRecord> {
  const nowIso = new Date().toISOString();
  const name = normalizeRequiredString(input.name, "name");
  const existing = await getKnowledgeBaseByName(ctx, companyId, name);
  const data = toKnowledgeBaseData(
    {
      ...input,
      companyId,
      name,
      updatedAt: nowIso,
    },
    nowIso,
    existing?.data,
  );

  if (!existing) {
    const created = await createEntity(ctx, {
      entityType: ENTITY_TYPES.knowledgeBase,
      scopeKind: "company",
      scopeId: companyId,
      externalId: data.name,
      title: data.name,
      status: "active",
      data: asDataRecord(data),
    });

    return toKnowledgeBaseRecord(created);
  }

  const updated = await updateEntity(ctx, existing.id, {
    externalId: data.name,
    title: data.name,
    status: "active",
    data: asDataRecord(data),
  });

  return toKnowledgeBaseRecord(updated);
}

export async function deleteKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  kbNameOrId: string,
): Promise<void> {
  const record = await resolveKnowledgeBaseRecord(ctx, companyId, kbNameOrId);
  if (!record) {
    return;
  }

  const grants = await listAgentKbGrants(ctx, companyId, {
    kbName: record.data.name,
  });

  await Promise.all(grants.map(async (grant) => {
    await deleteEntity(ctx, grant.id);
  }));

  await deleteEntity(ctx, record.id);
}

export async function listAgentKbGrants(
  ctx: PluginContext,
  companyId: string,
  filters?: {
    agentName?: string;
    kbName?: string;
  },
): Promise<AgentKBGrantRecord[]> {
  const listed = await listByType(ctx, ENTITY_TYPES.agentKbGrant, companyId);
  const agentName = asNonEmptyString(filters?.agentName);
  const kbName = asNonEmptyString(filters?.kbName);

  return listed
    .map(toGrantRecord)
    .filter((record) => (agentName ? record.data.agentName === agentName : true))
    .filter((record) => (kbName ? record.data.kbName === kbName : true))
    .sort((left, right) => {
      const agentOrder = left.data.agentName.localeCompare(right.data.agentName);
      if (agentOrder !== 0) {
        return agentOrder;
      }
      return left.data.kbName.localeCompare(right.data.kbName);
    });
}

export async function grantKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  input: Partial<AgentKBGrantData>,
): Promise<AgentKBGrantRecord> {
  const nowIso = new Date().toISOString();
  const draft = toGrantData(input, nowIso);
  const kb = await getKnowledgeBaseByName(ctx, companyId, draft.kbName);

  if (!kb) {
    throw new Error(`Knowledge base not found: ${draft.kbName}`);
  }

  const externalId = normalizeGrantExternalId(draft.agentName, draft.kbName);
  const existing = await findByExternalId(ctx, ENTITY_TYPES.agentKbGrant, companyId, externalId);
  const data = toGrantData(
    {
      ...draft,
      kbName: kb.data.name,
      grantedAt: nowIso,
    },
    nowIso,
    existing ? toGrantRecord(existing).data : undefined,
  );

  if (!existing) {
    const created = await createEntity(ctx, {
      entityType: ENTITY_TYPES.agentKbGrant,
      scopeKind: "company",
      scopeId: companyId,
      externalId,
      title: `${data.agentName} -> ${data.kbName}`,
      status: "active",
      data: asDataRecord(data),
    });

    return toGrantRecord(created);
  }

  const updated = await updateEntity(ctx, existing.id, {
    externalId,
    title: `${data.agentName} -> ${data.kbName}`,
    status: "active",
    data: asDataRecord(data),
  });

  return toGrantRecord(updated);
}

export async function revokeKnowledgeBaseGrant(
  ctx: PluginContext,
  companyId: string,
  input: {
    grantId?: string;
    agentName?: string;
    kbName?: string;
  },
): Promise<void> {
  const grantId = asNonEmptyString(input.grantId);

  if (grantId) {
    const found = await getById(ctx, ENTITY_TYPES.agentKbGrant, grantId);
    if (found && found.scopeId === companyId) {
      await deleteEntity(ctx, found.id);
    }
    return;
  }

  const agentName = normalizeRequiredString(input.agentName, "agentName");
  const kbName = normalizeRequiredString(input.kbName, "kbName");
  const externalId = normalizeGrantExternalId(agentName, kbName);
  const found = await findByExternalId(ctx, ENTITY_TYPES.agentKbGrant, companyId, externalId);

  if (found) {
    await deleteEntity(ctx, found.id);
  }
}

export async function listAgentNames(
  ctx: PluginContext,
  companyId: string,
): Promise<string[]> {
  const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });

  return Array.from(
    new Set(
      agents
        .map((agent) => asNonEmptyString(agent.name))
        .filter((name) => name.length > 0),
    ),
  ).sort((left, right) => left.localeCompare(right));
}

export async function getKnowledgeBaseOverview(
  ctx: PluginContext,
  companyId: string,
): Promise<{
  knowledgeBases: KnowledgeBaseRecord[];
  grants: AgentKBGrantRecord[];
  agents: string[];
}> {
  const [knowledgeBases, grants, agents] = await Promise.all([
    listKnowledgeBases(ctx, companyId),
    listAgentKbGrants(ctx, companyId),
    listAgentNames(ctx, companyId),
  ]);

  return {
    knowledgeBases,
    grants,
    agents,
  };
}
EOF' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "sed -n '1,220p' plugins/knowledge-base/src/kb-store.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
import {
  DEFAULT_MAX_TOKEN_BUDGET,
  ENTITY_TYPES,
  KB_TYPES,
} from "./constants.js";

type JsonRecord = Record<string, unknown>;

type PluginEntityScopeKind =
  | "instance"
  | "company"
  | "project"
  | "project_workspace"
  | "agent"
  | "issue"
  | "goal"
  | "run";

type EntityQuery = Parameters<PluginContext["entities"]["list"]>[0];
exec
/bin/zsh -lc "sed -n '220,520p' plugins/knowledge-base/src/kb-store.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
    ...(query as JsonRecord),
    id,
  } as EntityQuery;
}

async function listByType(
  ctx: PluginContext,
  entityType: string,
  companyId: string,
): Promise<PluginEntityRecord[]> {
  const listed = await entities(ctx).list({
    entityType,
    scopeKind: "company",
    scopeId: companyId,
    limit: 1000,
  } as EntityQuery);

  return listed
    .filter((record: PluginEntityRecord) => record.entityType === entityType)
    .filter((record: PluginEntityRecord) => asRecord(record.data).__deleted !== true);
exec
/bin/zsh -lc "sed -n '520,760p' plugins/knowledge-base/src/kb-store.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
      if (agentOrder !== 0) {
        return agentOrder;
      }
      return left.data.kbName.localeCompare(right.data.kbName);
    });
}

export async function grantKnowledgeBase(
  ctx: PluginContext,
  companyId: string,
  input: Partial<AgentKBGrantData>,
): Promise<AgentKBGrantRecord> {
  const nowIso = new Date().toISOString();
  const draft = toGrantData(input, nowIso);
  const kb = await getKnowledgeBaseByName(ctx, companyId, draft.kbName);

  if (!kb) {
    throw new Error(`Knowledge base not found: ${draft.kbName}`);
  }

exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/worker.ts <<'EOF'
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from \"@paperclipai/plugin-sdk\";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PLUGIN_ID,
} from \"./constants.js\";
import {
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBaseByName,
  getKnowledgeBaseOverview,
  grantKnowledgeBase,
  listAgentKbGrants,
  listAgentNames,
  listKnowledgeBases,
  revokeKnowledgeBaseGrant,
  upsertKnowledgeBase,
  type KnowledgeBaseType,
} from \"./kb-store.js\";

type JsonRecord = Record<string, unknown>;

type RunEventRefs = {
  runId: string;
  issueId: string;
  agentId: string;
  agentName: string;
};

function asRecord(value: unknown): JsonRecord {
  if ("'!value || typeof value !== "object") {
    return {};
  }

  return value as JsonRecord;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function getNestedString(record: JsonRecord, ...path: string[]): string {
  let cursor: unknown = record;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as JsonRecord)[key];
  }

  return asString(cursor);
}

function normalizeKnowledgeBaseType(value: unknown): KnowledgeBaseType {
  const normalized = asString(value).toLowerCase();

  if (normalized === KB_TYPES.rag) {
    return KB_TYPES.rag;
  }
  if (normalized === KB_TYPES.ontology) {
    return KB_TYPES.ontology;
  }

  return KB_TYPES.static;
}

function extractRunEventRefs(event: PluginEvent): RunEventRefs {
  const payload = asRecord(event.payload);

  const runId = asString(payload.runId)
    || asString(payload.run_id)
    || asString(payload.id)
    || asString(event.entityId);

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || getNestedString(payload, "issue", "id")
    || getNestedString(payload, "context", "issueId")
    || getNestedString(payload, "context", "issue", "id");

  const agentId = asString(payload.agentId)
    || asString(payload.agent_id)
    || getNestedString(payload, "agent", "id")
    || getNestedString(payload, "context", "agentId")
    || getNestedString(payload, "run", "agentId");

  const agentName = asString(payload.agentName)
    || asString(payload.agent_name)
    || getNestedString(payload, "agent", "name")
    || getNestedString(payload, "context", "agentName");

  return {
    runId,
    issueId,
    agentId,
    agentName,
  };
}

async function resolveAgentName(
  ctx: PluginContext,
  companyId: string,
  refs: RunEventRefs,
): Promise<string> {
  if (refs.agentName) {
    return refs.agentName;
  }

  if (!refs.agentId) {
    return "";
  }

  const agent = await ctx.agents.get(refs.agentId, companyId);
  return asString(agent?.name);
}

function truncateByTokenBudget(content: string, maxTokenBudget: number): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return "";
  }

  const budget = Number.isFinite(maxTokenBudget) && maxTokenBudget > 0
    ? Math.floor(maxTokenBudget)
    : 4096;

  const chunks = trimmedContent.match(/'"\\S+\\s*/g);
  if ("'!chunks || chunks.length <= budget) {
    return trimmedContent;
  }

  return chunks.slice(0, budget).join("").trimEnd();
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

async function handleAgentRunStarted(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const refs = extractRunEventRefs(event);
  const companyId = asString(event.companyId);

  if (!companyId || !refs.agentId) {
    return;
  }

  const agentName = await resolveAgentName(ctx, companyId, refs);
  if (!agentName) {
    ctx.logger.warn("Knowledge base injection skipped: unable to resolve agent name", {
      companyId,
      eventId: event.eventId,
      runId: refs.runId || null,
      agentId: refs.agentId,
    });
    return;
  }

  const grants = await listAgentKbGrants(ctx, companyId, { agentName });
  if (grants.length === 0) {
    return;
  }

  const uniqueKbNames = Array.from(new Set(grants.map((grant) => grant.data.kbName)));

  for (const kbName of uniqueKbNames) {
    const knowledgeBase = await getKnowledgeBaseByName(ctx, companyId, kbName);
    if (!knowledgeBase) {
      ctx.logger.warn("Knowledge base grant references missing KB", {
        companyId,
        agentName,
        kbName,
      });
      continue;
    }

    if (knowledgeBase.data.type === KB_TYPES.static) {
      if (!refs.issueId) {
        ctx.logger.warn("Knowledge base injection skipped: run issueId is missing", {
          companyId,
          agentName,
          kbName: knowledgeBase.data.name,
          runId: refs.runId || null,
        });
        continue;
      }

      const content = knowledgeBase.data.staticConfig?.content ?? "";
      const truncatedContent = truncateByTokenBudget(content, knowledgeBase.data.maxTokenBudget);
      const body = `## 참조 지식: ${knowledgeBase.data.name}'"\\n"'${truncatedContent || "(내용 없음)"}`;

      await ctx.issues.createComment(refs.issueId, body, companyId);
      continue;
    }

    ctx.logger.info("Knowledge base type is registered for future extension", {
      companyId,
      agentName,
      kbName: knowledgeBase.data.name,
      kbType: knowledgeBase.data.type,
      runId: refs.runId || null,
    });
  }

  ctx.logger.info("Knowledge base injection completed on agent.run.started", {
    companyId,
    agentId: refs.agentId,
    agentName,
    issueId: refs.issueId || null,
    runId: refs.runId || null,
    grantCount: grants.length,
    pluginId: PLUGIN_ID,
  });
}

function mapKnowledgeBaseList(records: Awaited<ReturnType<typeof listKnowledgeBases>>): Array<{
  id: string;
  name: string;
  type: string;
  description?: string;
  maxTokenBudget: number;
  createdAt: string;
  updatedAt: string;
}> {
  return records.map((record) => ({
    id: record.id,
    name: record.data.name,
    type: record.data.type,
    description: record.data.description,
    maxTokenBudget: record.data.maxTokenBudget,
    createdAt: record.data.createdAt,
    updatedAt: record.data.updatedAt,
  }));
}

async function registerKnowledgeBaseDataHandlers(ctx: PluginContext): Promise<void> {
  registerDataHandler(ctx, DATA_KEYS.overview, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return {
        knowledgeBases: [],
        grants: [],
        agents: [],
      };
    }

    const overview = await getKnowledgeBaseOverview(ctx, companyId);

    return {
      knowledgeBases: mapKnowledgeBaseList(overview.knowledgeBases),
      grants: overview.grants.map((grant) => ({
        id: grant.id,
        agentName: grant.data.agentName,
        kbName: grant.data.kbName,
        grantedBy: grant.data.grantedBy,
        grantedAt: grant.data.grantedAt,
      })),
      agents: overview.agents,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.kbList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const records = await listKnowledgeBases(ctx, companyId);
    return mapKnowledgeBaseList(records);
  });

  registerDataHandler(ctx, DATA_KEYS.kbGet, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return null;
    }

    const id = asString(params.id);
    const name = asString(params.name);

    const record = id
      ? await getKnowledgeBaseById(ctx, id)
      : name
        ? await getKnowledgeBaseByName(ctx, companyId, name)
        : null;

    if (!record || record.data.companyId !== companyId) {
      return null;
    }

    return {
      id: record.id,
      name: record.data.name,
      type: record.data.type,
      description: record.data.description,
      maxTokenBudget: record.data.maxTokenBudget,
      staticConfig: record.data.staticConfig,
      ragConfig: record.data.ragConfig,
      ontologyConfig: record.data.ontologyConfig,
      createdAt: record.data.createdAt,
      updatedAt: record.data.updatedAt,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.grantList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);
    const grants = await listAgentKbGrants(ctx, companyId, {
      agentName: agentName || undefined,
      kbName: kbName || undefined,
    });

    return grants.map((grant) => ({
      id: grant.id,
      agentName: grant.data.agentName,
      kbName: grant.data.kbName,
      grantedBy: grant.data.grantedBy,
      grantedAt: grant.data.grantedAt,
    }));
  });

  registerDataHandler(ctx, DATA_KEYS.agentList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    return await listAgentNames(ctx, companyId);
  });

  registerDataHandler(ctx, DATA_KEYS.kbCreate, async (params) => {
    const companyId = asString(params.companyId);
    const name = asString(params.name);
    if (!companyId || !name) {
      throw new Error("knowledge-base.create requires companyId and name");
    }

    const type = normalizeKnowledgeBaseType(params.type);
    const description = asString(params.description);
    const maxTokenBudget = asNumber(params.maxTokenBudget);
    const staticContent = asString(params.staticContent);

    const record = await upsertKnowledgeBase(ctx, companyId, {
      name,
      type,
      description: description || undefined,
      maxTokenBudget,
      staticConfig: {
        content: staticContent,
      },
      ragConfig: {
        mcpServerUrl: asString(params.ragMcpServerUrl) || undefined,
        topK: asNumber(params.ragTopK),
      },
      ontologyConfig: {
        kgPath: asString(params.ontologyKgPath) || undefined,
      },
    });

    return {
      id: record.id,
      name: record.data.name,
      type: record.data.type,
      description: record.data.description,
      maxTokenBudget: record.data.maxTokenBudget,
      staticConfig: record.data.staticConfig,
      ragConfig: record.data.ragConfig,
      ontologyConfig: record.data.ontologyConfig,
      updatedAt: record.data.updatedAt,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.kbUpdate, async (params) => {
    const companyId = asString(params.companyId);
    const id = asString(params.id);
    const name = asString(params.name);

    if (!companyId || (!id && !name)) {
      throw new Error("knowledge-base.update requires companyId and id or name");
    }

    const baseRecord = id
      ? await getKnowledgeBaseById(ctx, id)
      : await getKnowledgeBaseByName(ctx, companyId, name);

    if (!baseRecord || baseRecord.data.companyId !== companyId) {
      throw new Error("Knowledge base not found");
    }

    const nextName = asString(params.name) || baseRecord.data.name;
    const nextType = normalizeKnowledgeBaseType(params.type || baseRecord.data.type);
    const maxTokenBudget = asNumber(params.maxTokenBudget) ?? baseRecord.data.maxTokenBudget;

    const record = await upsertKnowledgeBase(ctx, companyId, {
      name: nextName,
      type: nextType,
      description: asString(params.description) || baseRecord.data.description,
      maxTokenBudget,
      staticConfig: {
        content: asString(params.staticContent) || baseRecord.data.staticConfig?.content || "",
      },
      ragConfig: {
        mcpServerUrl: asString(params.ragMcpServerUrl) || baseRecord.data.ragConfig?.mcpServerUrl,
        topK: asNumber(params.ragTopK) ?? baseRecord.data.ragConfig?.topK,
      },
      ontologyConfig: {
        kgPath: asString(params.ontologyKgPath) || baseRecord.data.ontologyConfig?.kgPath,
      },
    });

    return {
      id: record.id,
      name: record.data.name,
      type: record.data.type,
      description: record.data.description,
      maxTokenBudget: record.data.maxTokenBudget,
      staticConfig: record.data.staticConfig,
      ragConfig: record.data.ragConfig,
      ontologyConfig: record.data.ontologyConfig,
      updatedAt: record.data.updatedAt,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.kbDelete, async (params) => {
    const companyId = asString(params.companyId);
    const id = asString(params.id);
    const name = asString(params.name);

    if (!companyId || (!id && !name)) {
      throw new Error("knowledge-base.delete requires companyId and id or name");
    }

    await deleteKnowledgeBase(ctx, companyId, id || name);
    return {
      ok: true,
      id: id || null,
      name: name || null,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.grantCreate, async (params) => {
    const companyId = asString(params.companyId);
    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);
    const grantedBy = asString(params.grantedBy) || "knowledge-base-ui";

    if (!companyId || !agentName || !kbName) {
      throw new Error("knowledge-base.grant.create requires companyId, agentName, kbName");
    }

    const record = await grantKnowledgeBase(ctx, companyId, {
      agentName,
      kbName,
      grantedBy,
    });

    return {
      id: record.id,
      agentName: record.data.agentName,
      kbName: record.data.kbName,
      grantedBy: record.data.grantedBy,
      grantedAt: record.data.grantedAt,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.grantDelete, async (params) => {
    const companyId = asString(params.companyId);
    const grantId = asString(params.grantId);
    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);

    if (!companyId || (!grantId && (!agentName || !kbName))) {
      throw new Error("knowledge-base.grant.delete requires companyId and grantId or (agentName, kbName)");
    }

    await revokeKnowledgeBaseGrant(ctx, companyId, {
      grantId: grantId || undefined,
      agentName: agentName || undefined,
      kbName: kbName || undefined,
    });

    return {
      ok: true,
      grantId: grantId || null,
      agentName: agentName || null,
      kbName: kbName || null,
    };
  });
}

function registerKnowledgeBaseActionHandlers(ctx: PluginContext): void {
  registerActionHandler(ctx, ACTION_KEYS.kbCreate, async (params) => {
    return await (ctx.data as PluginContext["data"] & {
      handle?: (key: string, handler: (input: JsonRecord) => Promise<unknown>) => void;
    }) && (async () => {
      const companyId = asString(params.companyId);
      const name = asString(params.name);
      if (!companyId || !name) {
        throw new Error("knowledge-base.create requires companyId and name");
      }

      const type = normalizeKnowledgeBaseType(params.type);
      const description = asString(params.description);
      const maxTokenBudget = asNumber(params.maxTokenBudget);
      const staticContent = asString(params.staticContent);

      const record = await upsertKnowledgeBase(ctx, companyId, {
        name,
        type,
        description: description || undefined,
        maxTokenBudget,
        staticConfig: {
          content: staticContent,
        },
        ragConfig: {
          mcpServerUrl: asString(params.ragMcpServerUrl) || undefined,
          topK: asNumber(params.ragTopK),
        },
        ontologyConfig: {
          kgPath: asString(params.ontologyKgPath) || undefined,
        },
      });

      return {
        id: record.id,
        name: record.data.name,
        type: record.data.type,
      };
    })();
  });

  registerActionHandler(ctx, ACTION_KEYS.kbUpdate, async (params) => {
    const companyId = asString(params.companyId);
    const id = asString(params.id);
    const name = asString(params.name);

    if (!companyId || (!id && !name)) {
      throw new Error("knowledge-base.update requires companyId and id or name");
    }

    const baseRecord = id
      ? await getKnowledgeBaseById(ctx, id)
      : await getKnowledgeBaseByName(ctx, companyId, name);

    if (!baseRecord || baseRecord.data.companyId !== companyId) {
      throw new Error("Knowledge base not found");
    }

    const nextName = asString(params.name) || baseRecord.data.name;
    const nextType = normalizeKnowledgeBaseType(params.type || baseRecord.data.type);
    const maxTokenBudget = asNumber(params.maxTokenBudget) ?? baseRecord.data.maxTokenBudget;

    const record = await upsertKnowledgeBase(ctx, companyId, {
      name: nextName,
      type: nextType,
      description: asString(params.description) || baseRecord.data.description,
      maxTokenBudget,
      staticConfig: {
        content: asString(params.staticContent) || baseRecord.data.staticConfig?.content || "",
      },
      ragConfig: {
        mcpServerUrl: asString(params.ragMcpServerUrl) || baseRecord.data.ragConfig?.mcpServerUrl,
        topK: asNumber(params.ragTopK) ?? baseRecord.data.ragConfig?.topK,
      },
      ontologyConfig: {
        kgPath: asString(params.ontologyKgPath) || baseRecord.data.ontologyConfig?.kgPath,
      },
    });

    return {
      id: record.id,
      name: record.data.name,
      type: record.data.type,
    };
  });

  registerActionHandler(ctx, ACTION_KEYS.kbDelete, async (params) => {
    const companyId = asString(params.companyId);
    const id = asString(params.id);
    const name = asString(params.name);

    if (!companyId || (!id && !name)) {
      throw new Error("knowledge-base.delete requires companyId and id or name");
    }

    await deleteKnowledgeBase(ctx, companyId, id || name);

    return {
      ok: true,
    };
  });

  registerActionHandler(ctx, ACTION_KEYS.grantCreate, async (params) => {
    const companyId = asString(params.companyId);
    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);
    const grantedBy = asString(params.grantedBy) || "knowledge-base-ui";

    if (!companyId || !agentName || !kbName) {
      throw new Error("knowledge-base.grant.create requires companyId, agentName, kbName");
    }

    const record = await grantKnowledgeBase(ctx, companyId, {
      agentName,
      kbName,
      grantedBy,
    });

    return {
      id: record.id,
      agentName: record.data.agentName,
      kbName: record.data.kbName,
      grantedBy: record.data.grantedBy,
      grantedAt: record.data.grantedAt,
    };
  });

  registerActionHandler(ctx, ACTION_KEYS.grantDelete, async (params) => {
    const companyId = asString(params.companyId);
    const grantId = asString(params.grantId);
    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);

    if (!companyId || (!grantId && (!agentName || !kbName))) {
      throw new Error("knowledge-base.grant.delete requires companyId and grantId or (agentName, kbName)");
    }

    await revokeKnowledgeBaseGrant(ctx, companyId, {
      grantId: grantId || undefined,
      agentName: agentName || undefined,
      kbName: kbName || undefined,
    });

    return {
      ok: true,
    };
  });
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    await registerKnowledgeBaseDataHandlers(ctx);
    registerKnowledgeBaseActionHandlers(ctx);

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      await handleAgentRunStarted(ctx, event);
    });

    ctx.logger.info("Knowledge Base plugin worker initialized", {
      pluginId: PLUGIN_ID,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Knowledge Base worker ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
EOF' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

codex
`worker.ts` 생성 과정에서 `zsh` 히스토리 확장(`!`)로 문자열이 깨졌습니다. 해당 파일을 안전하게 다시 작성해 정합성을 복구한 뒤, 타입 점검까지 바로 이어가겠습니다.
exec
/bin/zsh -lc "set +H
cat > plugins/knowledge-base/src/worker.ts <<'EOF'
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from \"@paperclipai/plugin-sdk\";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PLUGIN_ID,
} from \"./constants.js\";
import {
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBaseByName,
  getKnowledgeBaseOverview,
  grantKnowledgeBase,
  listAgentKbGrants,
  listAgentNames,
  listKnowledgeBases,
  revokeKnowledgeBaseGrant,
  upsertKnowledgeBase,
  type KnowledgeBaseRecord,
  type KnowledgeBaseType,
} from \"./kb-store.js\";

type JsonRecord = Record<string, unknown>;

type RunEventRefs = {
  runId: string;
  issueId: string;
  agentId: string;
  agentName: string;
};

function asRecord(value: unknown): JsonRecord {
  if ("'!value || typeof value !== "object") {
    return {};
  }

  return value as JsonRecord;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  return value;
}

function hasOwn(record: JsonRecord, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function getNestedString(record: JsonRecord, ...path: string[]): string {
  let cursor: unknown = record;

  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return "";
    }
    cursor = (cursor as JsonRecord)[key];
  }

  return asString(cursor);
}

function normalizeKnowledgeBaseType(value: unknown): KnowledgeBaseType {
  const normalized = asString(value).toLowerCase();

  if (normalized === KB_TYPES.rag) {
    return KB_TYPES.rag;
  }
  if (normalized === KB_TYPES.ontology) {
    return KB_TYPES.ontology;
  }

  return KB_TYPES.static;
}

function extractRunEventRefs(event: PluginEvent): RunEventRefs {
  const payload = asRecord(event.payload);

  const runId = asString(payload.runId)
    || asString(payload.run_id)
    || asString(payload.id)
    || asString(event.entityId);

  const issueId = asString(payload.issueId)
    || asString(payload.issue_id)
    || getNestedString(payload, "issue", "id")
    || getNestedString(payload, "context", "issueId")
    || getNestedString(payload, "context", "issue", "id");

  const agentId = asString(payload.agentId)
    || asString(payload.agent_id)
    || getNestedString(payload, "agent", "id")
    || getNestedString(payload, "context", "agentId")
    || getNestedString(payload, "run", "agentId");

  const agentName = asString(payload.agentName)
    || asString(payload.agent_name)
    || getNestedString(payload, "agent", "name")
    || getNestedString(payload, "context", "agentName");

  return {
    runId,
    issueId,
    agentId,
    agentName,
  };
}

async function resolveAgentName(
  ctx: PluginContext,
  companyId: string,
  refs: RunEventRefs,
): Promise<string> {
  if (refs.agentName) {
    return refs.agentName;
  }

  if (!refs.agentId) {
    return "";
  }

  const agent = await ctx.agents.get(refs.agentId, companyId);
  return asString(agent?.name);
}

function truncateByTokenBudget(content: string, maxTokenBudget: number): string {
  const trimmedContent = content.trim();
  if (!trimmedContent) {
    return "";
  }

  const budget = Number.isFinite(maxTokenBudget) && maxTokenBudget > 0
    ? Math.floor(maxTokenBudget)
    : 4096;

  const chunks = trimmedContent.match(/'"\\S+\\s*/g);
  if ("'!chunks || chunks.length <= budget) {
    return trimmedContent;
  }

  return chunks.slice(0, budget).join("").trimEnd();
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

function toKnowledgeBaseListItem(record: KnowledgeBaseRecord): {
  id: string;
  name: string;
  type: string;
  description?: string;
  maxTokenBudget: number;
  createdAt: string;
  updatedAt: string;
} {
  return {
    id: record.id,
    name: record.data.name,
    type: record.data.type,
    description: record.data.description,
    maxTokenBudget: record.data.maxTokenBudget,
    createdAt: record.data.createdAt,
    updatedAt: record.data.updatedAt,
  };
}

function toKnowledgeBaseDetail(record: KnowledgeBaseRecord): {
  id: string;
  name: string;
  type: string;
  description?: string;
  maxTokenBudget: number;
  staticConfig?: { content: string };
  ragConfig?: { mcpServerUrl?: string; topK?: number };
  ontologyConfig?: { kgPath?: string };
  createdAt: string;
  updatedAt: string;
} {
  return {
    ...toKnowledgeBaseListItem(record),
    staticConfig: record.data.staticConfig,
    ragConfig: record.data.ragConfig,
    ontologyConfig: record.data.ontologyConfig,
  };
}

async function resolveKnowledgeBaseForUpdate(
  ctx: PluginContext,
  companyId: string,
  id: string,
  name: string,
): Promise<KnowledgeBaseRecord> {
  const record = id
    ? await getKnowledgeBaseById(ctx, id)
    : await getKnowledgeBaseByName(ctx, companyId, name);

  if (!record || record.data.companyId !== companyId) {
    throw new Error("Knowledge base not found");
  }

  return record;
}

async function createKnowledgeBaseFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<ReturnType<typeof toKnowledgeBaseDetail>> {
  const companyId = asString(params.companyId);
  const name = asString(params.name);

  if (!companyId || !name) {
    throw new Error("knowledge-base.create requires companyId and name");
  }

  const type = normalizeKnowledgeBaseType(params.type);
  const description = asString(params.description);
  const maxTokenBudget = asNumber(params.maxTokenBudget);

  const record = await upsertKnowledgeBase(ctx, companyId, {
    name,
    type,
    description: description || undefined,
    maxTokenBudget,
    staticConfig: {
      content: asString(params.staticContent),
    },
    ragConfig: {
      mcpServerUrl: asString(params.ragMcpServerUrl) || undefined,
      topK: asNumber(params.ragTopK),
    },
    ontologyConfig: {
      kgPath: asString(params.ontologyKgPath) || undefined,
    },
  });

  return toKnowledgeBaseDetail(record);
}

async function updateKnowledgeBaseFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<ReturnType<typeof toKnowledgeBaseDetail>> {
  const companyId = asString(params.companyId);
  const id = asString(params.id);
  const name = asString(params.name);

  if (!companyId || (!id && !name)) {
    throw new Error("knowledge-base.update requires companyId and id or name");
  }

  const baseRecord = await resolveKnowledgeBaseForUpdate(ctx, companyId, id, name);
  const nextType = hasOwn(params, "type")
    ? normalizeKnowledgeBaseType(params.type)
    : baseRecord.data.type;

  const nextDescription = hasOwn(params, "description")
    ? asString(params.description) || undefined
    : baseRecord.data.description;

  const nextMaxTokenBudget = hasOwn(params, "maxTokenBudget")
    ? asNumber(params.maxTokenBudget)
    : baseRecord.data.maxTokenBudget;

  const nextStaticContent = hasOwn(params, "staticContent")
    ? asString(params.staticContent)
    : (baseRecord.data.staticConfig?.content ?? "");

  const nextRagMcpServerUrl = hasOwn(params, "ragMcpServerUrl")
    ? asString(params.ragMcpServerUrl) || undefined
    : baseRecord.data.ragConfig?.mcpServerUrl;

  const nextRagTopK = hasOwn(params, "ragTopK")
    ? asNumber(params.ragTopK)
    : baseRecord.data.ragConfig?.topK;

  const nextOntologyKgPath = hasOwn(params, "ontologyKgPath")
    ? asString(params.ontologyKgPath) || undefined
    : baseRecord.data.ontologyConfig?.kgPath;

  const nextName = hasOwn(params, "name")
    ? asString(params.name) || baseRecord.data.name
    : baseRecord.data.name;

  const record = await upsertKnowledgeBase(ctx, companyId, {
    name: nextName,
    type: nextType,
    description: nextDescription,
    maxTokenBudget: nextMaxTokenBudget,
    staticConfig: {
      content: nextStaticContent,
    },
    ragConfig: {
      mcpServerUrl: nextRagMcpServerUrl,
      topK: nextRagTopK,
    },
    ontologyConfig: {
      kgPath: nextOntologyKgPath,
    },
  });

  return toKnowledgeBaseDetail(record);
}

async function deleteKnowledgeBaseFromParams(ctx: PluginContext, params: JsonRecord): Promise<{ ok: true }> {
  const companyId = asString(params.companyId);
  const id = asString(params.id);
  const name = asString(params.name);

  if (!companyId || (!id && !name)) {
    throw new Error("knowledge-base.delete requires companyId and id or name");
  }

  await deleteKnowledgeBase(ctx, companyId, id || name);
  return { ok: true };
}

async function createGrantFromParams(
  ctx: PluginContext,
  params: JsonRecord,
): Promise<{
  id: string;
  agentName: string;
  kbName: string;
  grantedBy: string;
  grantedAt: string;
}> {
  const companyId = asString(params.companyId);
  const agentName = asString(params.agentName);
  const kbName = asString(params.kbName);
  const grantedBy = asString(params.grantedBy) || "knowledge-base-ui";

  if (!companyId || !agentName || !kbName) {
    throw new Error("knowledge-base.grant.create requires companyId, agentName, kbName");
  }

  const record = await grantKnowledgeBase(ctx, companyId, {
    agentName,
    kbName,
    grantedBy,
  });

  return {
    id: record.id,
    agentName: record.data.agentName,
    kbName: record.data.kbName,
    grantedBy: record.data.grantedBy,
    grantedAt: record.data.grantedAt,
  };
}

async function deleteGrantFromParams(ctx: PluginContext, params: JsonRecord): Promise<{ ok: true }> {
  const companyId = asString(params.companyId);
  const grantId = asString(params.grantId);
  const agentName = asString(params.agentName);
  const kbName = asString(params.kbName);

  if (!companyId || (!grantId && (!agentName || !kbName))) {
    throw new Error("knowledge-base.grant.delete requires companyId and grantId or (agentName, kbName)");
  }

  await revokeKnowledgeBaseGrant(ctx, companyId, {
    grantId: grantId || undefined,
    agentName: agentName || undefined,
    kbName: kbName || undefined,
  });

  return { ok: true };
}

async function handleAgentRunStarted(ctx: PluginContext, event: PluginEvent): Promise<void> {
  const refs = extractRunEventRefs(event);
  const companyId = asString(event.companyId);

  if (!companyId || !refs.agentId) {
    return;
  }

  const agentName = await resolveAgentName(ctx, companyId, refs);
  if (!agentName) {
    ctx.logger.warn("Knowledge base injection skipped: unable to resolve agent name", {
      companyId,
      eventId: event.eventId,
      runId: refs.runId || null,
      agentId: refs.agentId,
    });
    return;
  }

  const grants = await listAgentKbGrants(ctx, companyId, { agentName });
  if (grants.length === 0) {
    return;
  }

  const uniqueKbNames = Array.from(new Set(grants.map((grant) => grant.data.kbName)));

  for (const kbName of uniqueKbNames) {
    const knowledgeBase = await getKnowledgeBaseByName(ctx, companyId, kbName);
    if (!knowledgeBase) {
      ctx.logger.warn("Knowledge base grant references missing KB", {
        companyId,
        agentName,
        kbName,
      });
      continue;
    }

    if (knowledgeBase.data.type === KB_TYPES.static) {
      if (!refs.issueId) {
        ctx.logger.warn("Knowledge base injection skipped: run issueId is missing", {
          companyId,
          agentName,
          kbName: knowledgeBase.data.name,
          runId: refs.runId || null,
        });
        continue;
      }

      const content = knowledgeBase.data.staticConfig?.content ?? "";
      const truncatedContent = truncateByTokenBudget(content, knowledgeBase.data.maxTokenBudget);
      const body = `## 참조 지식: ${knowledgeBase.data.name}'"\\n"'${truncatedContent || "(내용 없음)"}`;

      await ctx.issues.createComment(refs.issueId, body, companyId);
      continue;
    }

    ctx.logger.info("Knowledge base type is registered for future extension", {
      companyId,
      agentName,
      kbName: knowledgeBase.data.name,
      kbType: knowledgeBase.data.type,
      runId: refs.runId || null,
    });
  }

  ctx.logger.info("Knowledge base injection completed on agent.run.started", {
    companyId,
    agentId: refs.agentId,
    agentName,
    issueId: refs.issueId || null,
    runId: refs.runId || null,
    grantCount: grants.length,
    pluginId: PLUGIN_ID,
  });
}

async function registerKnowledgeBaseDataHandlers(ctx: PluginContext): Promise<void> {
  registerDataHandler(ctx, DATA_KEYS.overview, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return {
        knowledgeBases: [],
        grants: [],
        agents: [],
      };
    }

    const overview = await getKnowledgeBaseOverview(ctx, companyId);

    return {
      knowledgeBases: overview.knowledgeBases.map(toKnowledgeBaseListItem),
      grants: overview.grants.map((grant) => ({
        id: grant.id,
        agentName: grant.data.agentName,
        kbName: grant.data.kbName,
        grantedBy: grant.data.grantedBy,
        grantedAt: grant.data.grantedAt,
      })),
      agents: overview.agents,
    };
  });

  registerDataHandler(ctx, DATA_KEYS.kbList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const records = await listKnowledgeBases(ctx, companyId);
    return records.map(toKnowledgeBaseListItem);
  });

  registerDataHandler(ctx, DATA_KEYS.kbGet, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return null;
    }

    const id = asString(params.id);
    const name = asString(params.name);

    const record = id
      ? await getKnowledgeBaseById(ctx, id)
      : name
        ? await getKnowledgeBaseByName(ctx, companyId, name)
        : null;

    if (!record || record.data.companyId !== companyId) {
      return null;
    }

    return toKnowledgeBaseDetail(record);
  });

  registerDataHandler(ctx, DATA_KEYS.grantList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    const agentName = asString(params.agentName);
    const kbName = asString(params.kbName);
    const grants = await listAgentKbGrants(ctx, companyId, {
      agentName: agentName || undefined,
      kbName: kbName || undefined,
    });

    return grants.map((grant) => ({
      id: grant.id,
      agentName: grant.data.agentName,
      kbName: grant.data.kbName,
      grantedBy: grant.data.grantedBy,
      grantedAt: grant.data.grantedAt,
    }));
  });

  registerDataHandler(ctx, DATA_KEYS.agentList, async (params) => {
    const companyId = asString(params.companyId);
    if (!companyId) {
      return [];
    }

    return await listAgentNames(ctx, companyId);
  });

  registerDataHandler(ctx, DATA_KEYS.kbCreate, async (params) => {
    return await createKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.kbUpdate, async (params) => {
    return await updateKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.kbDelete, async (params) => {
    return await deleteKnowledgeBaseFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.grantCreate, async (params) => {
    return await createGrantFromParams(ctx, params);
  });

  registerDataHandler(ctx, DATA_KEYS.grantDelete, async (params) => {
    return await deleteGrantFromParams(ctx, params);
  });
}

function registerKnowledgeBaseActionHandlers(ctx: PluginContext): void {
  registerActionHandler(ctx, ACTION_KEYS.kbCreate, async (params) => {
    return await createKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.kbUpdate, async (params) => {
    return await updateKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.kbDelete, async (params) => {
    return await deleteKnowledgeBaseFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.grantCreate, async (params) => {
    return await createGrantFromParams(ctx, params);
  });

  registerActionHandler(ctx, ACTION_KEYS.grantDelete, async (params) => {
    return await deleteGrantFromParams(ctx, params);
  });
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    await registerKnowledgeBaseDataHandlers(ctx);
    registerKnowledgeBaseActionHandlers(ctx);

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      await handleAgentRunStarted(ctx, event);
    });

    ctx.logger.info("Knowledge Base plugin worker initialized", {
      pluginId: PLUGIN_ID,
    });
  },

  async onHealth() {
    return {
      status: "ok",
      message: "Knowledge Base worker ready",
    };
  },
});

export default plugin;
runWorker(plugin, import.meta.url);
EOF' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "sed -n '1,160p' plugins/knowledge-base/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import {
  definePlugin,
  runWorker,
  type PluginContext,
  type PluginEvent,
} from "@paperclipai/plugin-sdk";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PLUGIN_ID,
} from "./constants.js";
import {
  deleteKnowledgeBase,
  getKnowledgeBaseById,
  getKnowledgeBaseByName,
  getKnowledgeBaseOverview,
  grantKnowledgeBase,
  listAgentKbGrants,
  listAgentNames,
exec
/bin/zsh -lc "rg -n \"참조 지식|\\\\n\\"'$'"\\{truncatedContent|match\\(/\\\\S|knowledge-base\\.grant\" plugins/knowledge-base/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon exited 2 in 0ms:
rg: the literal "\n" is not allowed in a regex

Consider enabling multiline mode with the --multiline flag (or -U for short).
When multiline mode is enabled, new line characters can be matched.
exec
/bin/zsh -lc "sed -n '300,460p' plugins/knowledge-base/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
  const nextType = hasOwn(params, "type")
    ? normalizeKnowledgeBaseType(params.type)
    : baseRecord.data.type;

  const nextDescription = hasOwn(params, "description")
    ? asString(params.description) || undefined
    : baseRecord.data.description;

  const nextMaxTokenBudget = hasOwn(params, "maxTokenBudget")
    ? asNumber(params.maxTokenBudget)
    : baseRecord.data.maxTokenBudget;

  const nextStaticContent = hasOwn(params, "staticContent")
    ? asString(params.staticContent)
    : (baseRecord.data.staticConfig?.content ?? "");

  const nextRagMcpServerUrl = hasOwn(params, "ragMcpServerUrl")
    ? asString(params.ragMcpServerUrl) || undefined
    : baseRecord.data.ragConfig?.mcpServerUrl;

exec
/bin/zsh -lc "sed -n '460,620p' plugins/knowledge-base/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
          kbName: knowledgeBase.data.name,
          runId: refs.runId || null,
        });
        continue;
      }

      const content = knowledgeBase.data.staticConfig?.content ?? "";
      const truncatedContent = truncateByTokenBudget(content, knowledgeBase.data.maxTokenBudget);
      const body = `## 참조 지식: ${knowledgeBase.data.name}\n${truncatedContent || "(내용 없음)"}`;

      await ctx.issues.createComment(refs.issueId, body, companyId);
      continue;
    }

    ctx.logger.info("Knowledge base type is registered for future extension", {
      companyId,
      agentName,
      kbName: knowledgeBase.data.name,
      kbType: knowledgeBase.data.type,
      runId: refs.runId || null,
exec
/bin/zsh -lc "sed -n '620,760p' plugins/knowledge-base/src/worker.ts" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

  registerActionHandler(ctx, ACTION_KEYS.grantDelete, async (params) => {
    return await deleteGrantFromParams(ctx, params);
  });
}

const plugin = definePlugin({
  async setup(ctx: PluginContext) {
    await registerKnowledgeBaseDataHandlers(ctx);
    registerKnowledgeBaseActionHandlers(ctx);

    ctx.events.on("agent.run.started", async (event: PluginEvent) => {
      await handleAgentRunStarted(ctx, event);
    });

    ctx.logger.info("Knowledge Base plugin worker initialized", {
      pluginId: PLUGIN_ID,
    });
  },

codex
`worker/kb-store` 기본 로직이 들어갔고, 이제 UI를 연결합니다. 한 페이지 안에서 `목록/상세/에이전트 매핑`을 모두 제공하고, 사이드바 링크도 함께 추가하겠습니다.
exec
/bin/zsh -lc "cat > plugins/knowledge-base/src/ui/index.tsx <<'EOF'
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from \"@paperclipai/plugin-sdk/ui\";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useEffect,
  useMemo,
  useState,
} from \"react\";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PAGE_ROUTE,
  PLUGIN_ID,
} from \"../constants.js\";

type KnowledgeBaseItem = {
  id: string;
  name: string;
  type: \"static\" | \"rag\" | \"ontology\";
  description?: string;
  maxTokenBudget: number;
  createdAt: string;
  updatedAt: string;
};

type KnowledgeBaseGrant = {
  id: string;
  agentName: string;
  kbName: string;
  grantedBy: string;
  grantedAt: string;
};

type OverviewData = {
  knowledgeBases: KnowledgeBaseItem[];
  grants: KnowledgeBaseGrant[];
  agents: string[];
};

const pageStyle: CSSProperties = {
  display: \"grid\",
  gap: \"20px\",
  padding: \"24px\",
  fontFamily: \"ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, sans-serif\",
  color: \"#111827\",
};

const sectionStyle: CSSProperties = {
  display: \"grid\",
  gap: \"12px\",
  padding: \"16px\",
  borderRadius: \"12px\",
  border: \"1px solid #e5e7eb\",
  background: \"#ffffff\",
};

const titleStyle: CSSProperties = {
  margin: 0,
  fontSize: \"28px\",
  lineHeight: 1.2,
  fontWeight: 700,
};

const sectionTitleStyle: CSSProperties = {
  margin: 0,
  fontSize: \"18px\",
  lineHeight: 1.3,
  fontWeight: 600,
};

const mutedStyle: CSSProperties = {
  margin: 0,
  fontSize: \"13px\",
  color: \"#6b7280\",
};

const tableStyle: CSSProperties = {
  width: \"100%\",
  borderCollapse: \"collapse\",
  fontSize: \"14px\",
};

const thStyle: CSSProperties = {
  textAlign: \"left\",
  padding: \"10px 12px\",
  borderBottom: \"1px solid #e5e7eb\",
  fontSize: \"12px\",
  letterSpacing: \"0.03em\",
  color: \"#6b7280\",
  textTransform: \"uppercase\",
};

const tdStyle: CSSProperties = {
  padding: \"10px 12px\",
  borderBottom: \"1px solid #f3f4f6\",
  verticalAlign: \"top\",
};

const buttonStyle: CSSProperties = {
  border: \"1px solid #d1d5db\",
  borderRadius: \"8px\",
  background: \"#ffffff\",
  color: \"#111827\",
  fontSize: \"13px\",
  fontWeight: 600,
  cursor: \"pointer\",
  padding: \"8px 12px\",
};

const inputStyle: CSSProperties = {
  width: \"100%\",
  border: \"1px solid #d1d5db\",
  borderRadius: \"8px\",
  padding: \"8px 10px\",
  fontSize: \"14px\",
};

const textareaStyle: CSSProperties = {
  ...inputStyle,
  minHeight: \"140px\",
  resize: \"vertical\",
  lineHeight: 1.5,
};

function hostPath(companyPrefix: string | null | undefined, suffix: string): string {
  return companyPrefix ? "'`/${companyPrefix}${suffix}` : suffix;
}

function pluginPagePath(companyPrefix: string | null | undefined): string {
  return hostPath(companyPrefix, `/${PAGE_ROUTE}`);
}

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function KnowledgeBasePage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context.companyId ?? "";

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
  const [errorMessage, setErrorMessage] = useState<string>("");

  const [createName, setCreateName] = useState("");
  const [createType, setCreateType] = useState<"static" | "rag" | "ontology">("static");
  const [createDescription, setCreateDescription] = useState("");
  const [createTokenBudget, setCreateTokenBudget] = useState("4096");
  const [createStaticContent, setCreateStaticContent] = useState("");

  const [detailDescription, setDetailDescription] = useState("");
  const [detailTokenBudget, setDetailTokenBudget] = useState("4096");
  const [detailStaticContent, setDetailStaticContent] = useState("");

  const [grantAgentName, setGrantAgentName] = useState("");
  const [grantKbName, setGrantKbName] = useState("");

  const overview = usePluginData<OverviewData>(DATA_KEYS.overview, {
    companyId,
    refreshNonce,
  });

  const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
  const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
  const deleteKnowledgeBase = usePluginAction(ACTION_KEYS.kbDelete);
  const createGrant = usePluginAction(ACTION_KEYS.grantCreate);
  const deleteGrant = usePluginAction(ACTION_KEYS.grantDelete);

  const knowledgeBases = overview.data?.knowledgeBases ?? [];
  const grants = overview.data?.grants ?? [];
  const agents = overview.data?.agents ?? [];

  useEffect(() => {
    if (!selectedKbId && knowledgeBases.length > 0) {
      setSelectedKbId(knowledgeBases[0].id);
      return;
    }

    if (selectedKbId && !knowledgeBases.some((item) => item.id === selectedKbId)) {
      setSelectedKbId(knowledgeBases[0]?.id ?? "");
    }
  }, [knowledgeBases, selectedKbId]);

  const selectedKnowledgeBase = useMemo(
    () => knowledgeBases.find((item) => item.id === selectedKbId) ?? null,
    [knowledgeBases, selectedKbId],
  );

  useEffect(() => {
    if (!selectedKnowledgeBase) {
      return;
    }

    setDetailDescription(selectedKnowledgeBase.description ?? "");
    setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));

    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
      setDetailStaticContent("");
    }
  }, [selectedKnowledgeBase]);

  const selectedKbGrants = useMemo(
    () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),
    [grants, selectedKnowledgeBase],
  );

  async function refreshOverview() {
    setRefreshNonce((value) => value + 1);
    await overview.refresh();
  }

  async function onCreateKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMessage("");
    setErrorMessage("");

    try {
      const result = await createKnowledgeBase({
        companyId,
        name: createName,
        type: createType,
        description: createDescription,
        maxTokenBudget: Number(createTokenBudget),
        staticContent: createStaticContent,
      }) as { id?: string };

      setCreateName("");
      setCreateDescription("");
      setCreateTokenBudget("4096");
      setCreateStaticContent("");
      setCreateType("static");

      await refreshOverview();
      if (result?.id) {
        setSelectedKbId(result.id);
      }
      setStatusMessage("Knowledge Base를 저장했습니다.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function onSaveDetail() {
    if (!selectedKnowledgeBase) {
      return;
    }

    setStatusMessage("");
    setErrorMessage("");

    try {
      await updateKnowledgeBase({
        companyId,
        id: selectedKnowledgeBase.id,
        name: selectedKnowledgeBase.name,
        description: detailDescription,
        maxTokenBudget: Number(detailTokenBudget),
        staticContent: detailStaticContent,
      });

      await refreshOverview();
      setStatusMessage("KB 상세 정보를 업데이트했습니다.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function onDeleteSelected() {
    if (!selectedKnowledgeBase) {
      return;
    }

    setStatusMessage("");
    setErrorMessage("");

    try {
      await deleteKnowledgeBase({
        companyId,
        id: selectedKnowledgeBase.id,
      });

      await refreshOverview();
      setStatusMessage("Knowledge Base를 삭제했습니다.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function onCreateGrant(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatusMessage("");
    setErrorMessage("");

    try {
      await createGrant({
        companyId,
        agentName: grantAgentName,
        kbName: grantKbName,
        grantedBy: "knowledge-base-ui",
      });

      await refreshOverview();
      setStatusMessage("에이전트 권한을 추가했습니다.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  async function onDeleteGrant(grant: KnowledgeBaseGrant) {
    setStatusMessage("");
    setErrorMessage("");

    try {
      await deleteGrant({
        companyId,
        grantId: grant.id,
      });
      await refreshOverview();
      setStatusMessage("에이전트 권한을 해제했습니다.");
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : String(error));
    }
  }

  if (overview.loading) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
        <h1 style={titleStyle}>Knowledge Base</h1>
        <p style={mutedStyle}>Knowledge Base 데이터를 불러오는 중...</p>
      </div>
    );
  }

  if (overview.error) {
    return (
      <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
        <h1 style={titleStyle}>Knowledge Base</h1>
        <p style={mutedStyle}>데이터 로드 실패: {overview.error.message}</p>
      </div>
    );
  }

  return (
    <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
      <h1 style={titleStyle}>Knowledge Base</h1>

      {statusMessage ? <p style={{ ...mutedStyle, color: "#065f46" }}>{statusMessage}</p> : null}
      {errorMessage ? <p style={{ ...mutedStyle, color: "#b91c1c" }}>{errorMessage}</p> : null}

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>KB 목록</h2>
        {knowledgeBases.length === 0 ? (
          <p style={mutedStyle}>등록된 Knowledge Base가 없습니다.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Token Budget</th>
                <th style={thStyle}>Updated</th>
              </tr>
            </thead>
            <tbody>
              {knowledgeBases.map((kb) => (
                <tr key={kb.id}>
                  <td style={tdStyle}>
                    <button
                      type="button"
                      onClick={() => {
                        setSelectedKbId(kb.id);
                        setGrantKbName(kb.name);
                      }}
                      style={{
                        ...buttonStyle,
                        padding: "4px 8px",
                        fontWeight: kb.id === selectedKbId ? 700 : 500,
                        borderColor: kb.id === selectedKbId ? "#2563eb" : "#d1d5db",
                      }}
                    >
                      {kb.name}
                    </button>
                  </td>
                  <td style={tdStyle}>{kb.type}</td>
                  <td style={tdStyle}>{kb.maxTokenBudget}</td>
                  <td style={tdStyle}>{formatDateTime(kb.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>KB 생성</h2>
        <form onSubmit={onCreateKnowledgeBase} style={{ display: "grid", gap: "10px" }}>
          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>이름</span>
            <input required value={createName} onChange={(event) => setCreateName(event.target.value)} style={inputStyle} />
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>타입</span>
            <select
              value={createType}
              onChange={(event) => setCreateType(event.target.value as "static" | "rag" | "ontology")}
              style={inputStyle}
            >
              <option value={KB_TYPES.static}>static</option>
              <option value={KB_TYPES.rag}>rag</option>
              <option value={KB_TYPES.ontology}>ontology</option>
            </select>
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>설명</span>
            <input value={createDescription} onChange={(event) => setCreateDescription(event.target.value)} style={inputStyle} />
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>Max Token Budget</span>
            <input
              type="number"
              min={1}
              value={createTokenBudget}
              onChange={(event) => setCreateTokenBudget(event.target.value)}
              style={inputStyle}
            />
          </label>

          {createType === KB_TYPES.static ? (
            <label style={{ display: "grid", gap: "6px" }}>
              <span style={mutedStyle}>Static Content</span>
              <textarea
                value={createStaticContent}
                onChange={(event) => setCreateStaticContent(event.target.value)}
                style={textareaStyle}
              />
            </label>
          ) : (
            <p style={mutedStyle}>`rag`, `ontology` 타입은 현재 이벤트 로그만 동작합니다.</p>
          )}

          <div>
            <button type="submit" style={buttonStyle}>KB 저장</button>
          </div>
        </form>
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>KB 상세</h2>
        {!selectedKnowledgeBase ? (
          <p style={mutedStyle}>목록에서 KB를 선택하세요.</p>
        ) : (
          <div style={{ display: "grid", gap: "10px" }}>
            <p style={mutedStyle}>
              선택된 KB: <strong>{selectedKnowledgeBase.name}</strong> ({selectedKnowledgeBase.type})
            </p>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={mutedStyle}>설명</span>
              <input
                value={detailDescription}
                onChange={(event) => setDetailDescription(event.target.value)}
                style={inputStyle}
              />
            </label>

            <label style={{ display: "grid", gap: "6px" }}>
              <span style={mutedStyle}>Max Token Budget</span>
              <input
                type="number"
                min={1}
                value={detailTokenBudget}
                onChange={(event) => setDetailTokenBudget(event.target.value)}
                style={inputStyle}
              />
            </label>

            {selectedKnowledgeBase.type === KB_TYPES.static ? (
              <label style={{ display: "grid", gap: "6px" }}>
                <span style={mutedStyle}>Static Content</span>
                <textarea
                  value={detailStaticContent}
                  onChange={(event) => setDetailStaticContent(event.target.value)}
                  style={textareaStyle}
                />
              </label>
            ) : (
              <p style={mutedStyle}>이 KB 타입은 현재 상세 편집 없이 매핑만 관리합니다.</p>
            )}

            <div style={{ display: "flex", gap: "8px", flexWrap: "wrap" }}>
              <button type="button" style={buttonStyle} onClick={() => void onSaveDetail()}>저장</button>
              <button
                type="button"
                style={{ ...buttonStyle, borderColor: "#fecaca", color: "#b91c1c" }}
                onClick={() => void onDeleteSelected()}
              >
                삭제
              </button>
            </div>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>에이전트-KB 연결</h2>

        <form onSubmit={onCreateGrant} style={{ display: "grid", gap: "10px" }}>
          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>Agent Name</span>
            <select
              required
              value={grantAgentName}
              onChange={(event) => setGrantAgentName(event.target.value)}
              style={inputStyle}
            >
              <option value="">선택하세요</option>
              {agents.map((agentName) => (
                <option key={agentName} value={agentName}>{agentName}</option>
              ))}
            </select>
          </label>

          <label style={{ display: "grid", gap: "6px" }}>
            <span style={mutedStyle}>KB Name</span>
            <select
              required
              value={grantKbName}
              onChange={(event) => setGrantKbName(event.target.value)}
              style={inputStyle}
            >
              <option value="">선택하세요</option>
              {knowledgeBases.map((kb) => (
                <option key={kb.id} value={kb.name}>{kb.name}</option>
              ))}
            </select>
          </label>

          <div>
            <button type="submit" style={buttonStyle}>권한 추가</button>
          </div>
        </form>

        {selectedKnowledgeBase ? (
          <div style={{ display: "grid", gap: "10px" }}>
            <p style={mutedStyle}>
              <strong>{selectedKnowledgeBase.name}</strong> 에 연결된 에이전트
            </p>

            {selectedKbGrants.length === 0 ? (
              <p style={mutedStyle}>연결된 에이전트가 없습니다.</p>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr>
                    <th style={thStyle}>Agent</th>
                    <th style={thStyle}>Granted By</th>
                    <th style={thStyle}>Granted At</th>
                    <th style={thStyle}>Action</th>
                  </tr>
                </thead>
                <tbody>
                  {selectedKbGrants.map((grant) => (
                    <tr key={grant.id}>
                      <td style={tdStyle}>{grant.agentName}</td>
                      <td style={tdStyle}>{grant.grantedBy}</td>
                      <td style={tdStyle}>{formatDateTime(grant.grantedAt)}</td>
                      <td style={tdStyle}>
                        <button
                          type="button"
                          style={{ ...buttonStyle, padding: "6px 10px" }}
                          onClick={() => {
                            void onDeleteGrant(grant);
                          }}
                        >
                          해제
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </section>
    </div>
  );
}

export function KnowledgeBaseSidebarLink({ context }: PluginSidebarProps): JSX.Element {
  const href = pluginPagePath(context.companyPrefix);
  const isActive = typeof window !== "undefined" && window.location.pathname === href;

  return (
    <a
      href={href}
      aria-current={isActive ? "page" : undefined}
      className={[
        "flex items-center gap-2.5 px-3 py-2 text-[13px] font-medium transition-colors",
        isActive
          ? "bg-accent text-foreground"
          : "text-foreground/80 hover:bg-accent/50 hover:text-foreground",
      ].join(" ")}
    >
      <span aria-hidden="true">KB</span>
      <span className="truncate">Knowledge Base</span>
    </a>
  );
}
EOF' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

exec
/bin/zsh -lc "sed -n '1,140p' plugins/knowledge-base/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
import {
  useHostContext,
  usePluginAction,
  usePluginData,
  type PluginPageProps,
  type PluginSidebarProps,
} from "@paperclipai/plugin-sdk/ui";
import {
  type CSSProperties,
  type FormEvent,
  type JSX,
  useEffect,
  useMemo,
  useState,
} from "react";
import {
  ACTION_KEYS,
  DATA_KEYS,
  KB_TYPES,
  PAGE_ROUTE,
exec
/bin/zsh -lc "sed -n '140,360p' plugins/knowledge-base/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:

function formatDateTime(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(parsed);
}

export function KnowledgeBasePage(props: PluginPageProps): JSX.Element {
  const hostContext = useHostContext();
  const companyId = hostContext.companyId ?? props.context.companyId ?? "";

  const [refreshNonce, setRefreshNonce] = useState(0);
  const [selectedKbId, setSelectedKbId] = useState<string>("");
  const [statusMessage, setStatusMessage] = useState<string>("");
exec
/bin/zsh -lc "sed -n '360,760p' plugins/knowledge-base/src/ui/index.tsx" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
  return (
    <div data-plugin-id={PLUGIN_ID} style={pageStyle}>
      <h1 style={titleStyle}>Knowledge Base</h1>

      {statusMessage ? <p style={{ ...mutedStyle, color: "#065f46" }}>{statusMessage}</p> : null}
      {errorMessage ? <p style={{ ...mutedStyle, color: "#b91c1c" }}>{errorMessage}</p> : null}

      <section style={sectionStyle}>
        <h2 style={sectionTitleStyle}>KB 목록</h2>
        {knowledgeBases.length === 0 ? (
          <p style={mutedStyle}>등록된 Knowledge Base가 없습니다.</p>
        ) : (
          <table style={tableStyle}>
            <thead>
              <tr>
                <th style={thStyle}>Name</th>
                <th style={thStyle}>Type</th>
                <th style={thStyle}>Token Budget</th>
                <th style={thStyle}>Updated</th>
              </tr>
exec
/bin/zsh -lc 'find plugins/knowledge-base -maxdepth 3 -type f | sort' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
plugins/knowledge-base/package.json
plugins/knowledge-base/scripts/build-ui.mjs
plugins/knowledge-base/src/constants.ts
plugins/knowledge-base/src/index.ts
plugins/knowledge-base/src/kb-store.ts
plugins/knowledge-base/src/manifest.ts
plugins/knowledge-base/src/ui/index.tsx
plugins/knowledge-base/src/worker.ts
plugins/knowledge-base/tsconfig.json
codex
파일 생성은 완료됐고, 이제 가능한 범위에서 타입 검증을 시도해 보겠습니다. 환경 제약으로 실패하면 실패 원인까지 같이 정리해 드리겠습니다.
exec
/bin/zsh -lc 'pnpm -C plugins/knowledge-base typecheck' in /Users/kwak/Projects/paperclip/paperclip-addon exited 2 in 453ms:

> @insightflo/paperclip-knowledge-base@0.1.0 typecheck /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base
> tsc --noEmit

src/kb-store.ts(1,56): error TS2307: Cannot find module '@paperclipai/plugin-sdk' or its corresponding type declarations.
src/kb-store.ts(611,3): error TS2322: Type 'unknown[]' is not assignable to type 'string[]'.
  Type 'unknown' is not assignable to type 'string'.
src/kb-store.ts(614,15): error TS7006: Parameter 'agent' implicitly has an 'any' type.
src/kb-store.ts(615,18): error TS7006: Parameter 'name' implicitly has an 'any' type.
src/kb-store.ts(617,27): error TS18046: 'left' is of type 'unknown'.
src/manifest.ts(1,48): error TS2307: Cannot find module '@paperclipai/plugin-sdk' or its corresponding type declarations.
src/ui/index.tsx(7,8): error TS2307: Cannot find module '@paperclipai/plugin-sdk/ui' or its corresponding type declarations.
src/ui/index.tsx(15,8): error TS2307: Cannot find module 'react' or its corresponding type declarations.
src/ui/index.tsx(196,47): error TS7006: Parameter 'item' implicitly has an 'any' type.
src/ui/index.tsx(202,32): error TS7006: Parameter 'item' implicitly has an 'any' type.
src/ui/index.tsx(220,26): error TS7006: Parameter 'grant' implicitly has an 'any' type.
src/ui/index.tsx(225,22): error TS7006: Parameter 'value' implicitly has an 'any' type.
src/ui/index.tsx(344,7): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
src/ui/index.tsx(344,7): error TS2875: This JSX tag requires the module path 'react/jsx-runtime' to exist, but none could be found. Make sure you have types for the appropriate package installed.
src/ui/index.tsx(345,9): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
codex
타입체크 로그를 확인했고, 의존성 미설치 이슈와 별개로 잠재 타입 경고가 생길 수 있는 부분(`listAgentNames`)은 지금 바로 보강해서 코드 자체 안정성을 높이겠습니다.
file update
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -83,2 +83,4 @@
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
@@ -613,6 +615,6 @@
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
apply_patch(auto_approved=true) exited 0 in 41ms:
Success. Updated the following files:
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(

file update:
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(

file update
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/package.json
@@ -3,3 +3,3 @@
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
apply_patch(auto_approved=true) exited 0 in 52ms:
Success. Updated the following files:
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/package.json
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(

file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(

file update
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -33,2 +33,15 @@
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
@@ -178,2 +191,7 @@
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
@@ -206,2 +224,10 @@
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
@@ -213,6 +239,14 @@
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
apply_patch(auto_approved=true) exited 0 in 66ms:
Success. Updated the following files:
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc 'pnpm -C plugins/knowledge-base typecheck' in /Users/kwak/Projects/paperclip/paperclip-addon exited 2 in 402ms:

> @insightflo/paperclip-knowledge-base@0.1.0 typecheck /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base
> tsc --noEmit

src/kb-store.ts(1,56): error TS2307: Cannot find module '@paperclipai/plugin-sdk' or its corresponding type declarations.
src/kb-store.ts(613,3): error TS2322: Type 'unknown[]' is not assignable to type 'string[]'.
  Type 'unknown' is not assignable to type 'string'.
src/kb-store.ts(619,10): error TS2345: Argument of type '(left: string, right: string) => number' is not assignable to parameter of type '(a: unknown, b: unknown) => number'.
  Types of parameters 'left' and 'a' are incompatible.
    Type 'unknown' is not assignable to type 'string'.
src/manifest.ts(1,48): error TS2307: Cannot find module '@paperclipai/plugin-sdk' or its corresponding type declarations.
src/ui/index.tsx(7,8): error TS2307: Cannot find module '@paperclipai/plugin-sdk/ui' or its corresponding type declarations.
src/ui/index.tsx(15,8): error TS2307: Cannot find module 'react' or its corresponding type declarations.
src/ui/index.tsx(214,47): error TS7006: Parameter 'item' implicitly has an 'any' type.
src/ui/index.tsx(220,32): error TS7006: Parameter 'item' implicitly has an 'any' type.
src/ui/index.tsx(254,26): error TS7006: Parameter 'grant' implicitly has an 'any' type.
src/ui/index.tsx(259,22): error TS7006: Parameter 'value' implicitly has an 'any' type.
src/ui/index.tsx(378,7): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
src/ui/index.tsx(378,7): error TS2875: This JSX tag requires the module path 'react/jsx-runtime' to exist, but none could be found. Make sure you have types for the appropriate package installed.
src/ui/index.tsx(379,9): error TS7026: JSX element implicitly has type 'any' because no interface 'JSX.IntrinsicElements' exists.
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..5118f5f64077815dbbf7dcc035eec50ba5999fc1
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -611,10 +613,10 @@
   return Array.from(
     new Set(
       agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
+        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
+        .filter((name: string) => name.length > 0),
     ),
-  ).sort((left, right) => left.localeCompare(right));
+  ).sort((left: string, right: string) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

file update
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -611,10 +611,12 @@
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent: AgentRecord) => asNonEmptyString(agent.name))
-        .filter((name: string) => name.length > 0),
-    ),
-  ).sort((left: string, right: string) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
apply_patch(auto_approved=true) exited 0 in 86ms:
Success. Updated the following files:
M /Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc "git status --short plugins/knowledge-base && git diff -- plugins/knowledge-base | sed -n '1,260p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
?? plugins/knowledge-base/
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/constants.ts | sed -n '1,200p'" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/manifest.ts | sed -n '1,220p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
     1	export const PLUGIN_ID = "insightflo.knowledge-base";
     2	export const PLUGIN_VERSION = "0.1.0";
     3	export const PAGE_ROUTE = "knowledge-base";
     4	
     5	export const SLOT_IDS = {
     6	  page: "knowledge-base-page",
     7	  sidebar: "knowledge-base-sidebar",
     8	} as const;
     9	
    10	export const EXPORT_NAMES = {
    11	  page: "KnowledgeBasePage",
    12	  sidebar: "KnowledgeBaseSidebarLink",
    13	} as const;
    14	
    15	export const ENTITY_TYPES = {
    16	  knowledgeBase: "knowledge-base",
    17	  agentKbGrant: "agent-kb-grant",
    18	} as const;
    19	
    20	export const KB_TYPES = {
 succeeded in 0ms:
     1	import type { PaperclipPluginManifestV1 } from "@paperclipai/plugin-sdk";
     2	import {
     3	  EXPORT_NAMES,
     4	  PAGE_ROUTE,
     5	  PLUGIN_ID,
     6	  PLUGIN_VERSION,
     7	  SLOT_IDS,
     8	} from "./constants.js";
     9	
    10	const manifest: PaperclipPluginManifestV1 = {
    11	  id: PLUGIN_ID,
    12	  apiVersion: 1,
    13	  version: PLUGIN_VERSION,
    14	  displayName: "Knowledge Base",
    15	  description: "Registers company knowledge sources and grants agent-level access at run time.",
    16	  author: "InsightFlo",
    17	  categories: ["knowledge", "automation"],
    18	  capabilities: [
    19	    "events.subscribe",
    20	    "agents.read",
exec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/kb-store.ts | sed -n '1,260p'" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/worker.ts | sed -n '1,340p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
     1	import type { PluginContext, PluginEntityRecord } from "@paperclipai/plugin-sdk";
     2	import {
     3	  DEFAULT_MAX_TOKEN_BUDGET,
     4	  ENTITY_TYPES,
     5	  KB_TYPES,
     6	} from "./constants.js";
     7	
     8	type JsonRecord = Record<string, unknown>;
     9	
    10	type PluginEntityScopeKind =
    11	  | "instance"
    12	  | "company"
    13	  | "project"
    14	  | "project_workspace"
    15	  | "agent"
    16	  | "issue"
    17	  | "goal"
    18	  | "run";
    19	
    20	type EntityQuery = Parameters<PluginContext["entities"]["list"]>[0];
 succeeded in 0ms:
     1	import {
     2	  definePlugin,
     3	  runWorker,
     4	  type PluginContext,
     5	  type PluginEvent,
     6	} from "@paperclipai/plugin-sdk";
     7	import {
     8	  ACTION_KEYS,
     9	  DATA_KEYS,
    10	  KB_TYPES,
    11	  PLUGIN_ID,
    12	} from "./constants.js";
    13	import {
    14	  deleteKnowledgeBase,
    15	  getKnowledgeBaseById,
    16	  getKnowledgeBaseByName,
    17	  getKnowledgeBaseOverview,
    18	  grantKnowledgeBase,
    19	  listAgentKbGrants,
    20	  listAgentNames,
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/ui/index.tsx | sed -n '260,760p'" in /Users/kwak/Projects/paperclip/paperclip-addonexec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/ui/index.tsx | sed -n '1,260p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
     1	import {
     2	  useHostContext,
     3	  usePluginAction,
     4	  usePluginData,
     5	  type PluginPageProps,
     6	  type PluginSidebarProps,
     7	} from "@paperclipai/plugin-sdk/ui";
     8	import {
     9	  type CSSProperties,
    10	  type FormEvent,
    11	  type JSX,
    12	  useEffect,
    13	  useMemo,
    14	  useState,
    15	} from "react";
    16	import {
    17	  ACTION_KEYS,
    18	  DATA_KEYS,
    19	  KB_TYPES,
    20	  PAGE_ROUTE,
 succeeded in 0ms:
   260	    await overview.refresh();
   261	  }
   262	
   263	  async function onCreateKnowledgeBase(event: FormEvent<HTMLFormElement>) {
   264	    event.preventDefault();
   265	    setStatusMessage("");
   266	    setErrorMessage("");
   267	
   268	    try {
   269	      const result = await createKnowledgeBase({
   270	        companyId,
   271	        name: createName,
   272	        type: createType,
   273	        description: createDescription,
   274	        maxTokenBudget: Number(createTokenBudget),
   275	        staticContent: createStaticContent,
   276	      }) as { id?: string };
   277	
   278	      setCreateName("");
   279	      setCreateDescription("");
exec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/kb-store.ts | sed -n '260,760p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
   260	  const direct = directMatches.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
   261	  if (direct) {
   262	    return direct;
   263	  }
   264	
   265	  const fallback = await listByType(ctx, entityType, companyId);
   266	  return fallback.find((record: PluginEntityRecord) => record.externalId === externalId) ?? null;
   267	}
   268	
   269	async function getById(
   270	  ctx: PluginContext,
   271	  entityType: string,
   272	  id: string,
   273	): Promise<PluginEntityRecord | null> {
   274	  const listClient = entities(ctx);
   275	  const withId = await listClient.list(queryWithOptionalId({ entityType, limit: 10 } as EntityQuery, id));
   276	  const fromList = withId.find(
   277	    (record: PluginEntityRecord) => record.id === id && record.entityType === entityType,
   278	  ) ?? null;
   279	
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc "nl -ba plugins/knowledge-base/src/worker.ts | sed -n '340,760p'" in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
   340	    ragConfig: {
   341	      mcpServerUrl: nextRagMcpServerUrl,
   342	      topK: nextRagTopK,
   343	    },
   344	    ontologyConfig: {
   345	      kgPath: nextOntologyKgPath,
   346	    },
   347	  });
   348	
   349	  return toKnowledgeBaseDetail(record);
   350	}
   351	
   352	async function deleteKnowledgeBaseFromParams(ctx: PluginContext, params: JsonRecord): Promise<{ ok: true }> {
   353	  const companyId = asString(params.companyId);
   354	  const id = asString(params.id);
   355	  const name = asString(params.name);
   356	
   357	  if (!companyId || (!id && !name)) {
   358	    throw new Error("knowledge-base.delete requires companyId and id or name");
   359	  }
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

exec
/bin/zsh -lc 'git status --short' in /Users/kwak/Projects/paperclip/paperclip-addon succeeded in 0ms:
 D ../AGENTS.md
 D ../CONTRIBUTING.md
 D ../Dockerfile
 D ../Dockerfile.onboard-smoke
 D ../LICENSE
 D ../README.md
 D ../cli/CHANGELOG.md
 D ../cli/esbuild.config.mjs
 D ../cli/package.json
 D ../cli/src/__tests__/agent-jwt-env.test.ts
 D ../cli/src/__tests__/allowed-hostname.test.ts
 D ../cli/src/__tests__/auth-command-registration.test.ts
 D ../cli/src/__tests__/board-auth.test.ts
 D ../cli/src/__tests__/common.test.ts
 D ../cli/src/__tests__/company-delete.test.ts
 D ../cli/src/__tests__/company-import-export-e2e.test.ts
 D ../cli/src/__tests__/company-import-url.test.ts
 D ../cli/src/__tests__/company.test.ts
 D ../cli/src/__tests__/context.test.ts
 D ../cli/src/__tests__/data-dir.test.ts
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

codex
구현 완료했습니다. `plugins/knowledge-base`에 요청하신 전체 파일을 생성했고, `workflow-engine` 구조를 맞춰 구성했습니다.

- 생성 파일
  - [package.json](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/package.json)
  - [tsconfig.json](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/tsconfig.json)
  - [scripts/build-ui.mjs](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/scripts/build-ui.mjs)
  - [constants.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/constants.ts)
  - [index.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/index.ts)
  - [manifest.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/manifest.ts)
  - [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts)
  - [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts)
  - [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx)

핵심 반영 사항:

- `ctx.entities` 기반 KB/Grant CRUD 구현: [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts:49)
- `AgentKBGrant`를 `agentName + kbName` 기준으로 관리 (ID 하드코딩 없음): [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts:529)
- `agent.run.started`에서 `agentId -> agentName` resolve 후 KB 주입:
  - 이벤트 처리: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:418)
  - 주입 포맷 `## 참조 지식: {KB name}\n{content}`: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:468)
  - `rag/ontology`는 현재 로그만 남기도록 처리: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:474)
- UI에 KB 목록/상세(static 편집)/에이전트 매핑/사이드바 링크 구현:
  - 페이지: [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx:166)
  - 사이드바: [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx:644)
- Manifest capability + page/sidebar 슬롯 등록: [manifest.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/manifest.ts:10)

검증:

- 실행: `pnpm -C plugins/knowledge-base typecheck`
- 결과: 실패 (현재 폴더에 `node_modules`가 없어 `@paperclipai/plugin-sdk`, `react`를 해석하지 못함).  
  즉, 현재 실패는 환경 의존성 부재가 주원인입니다.
file update:
diff --git a/paperclip-addon/plugins/knowledge-base/package.json b/paperclip-addon/plugins/knowledge-base/package.json
index 49b7055f58379098ac1a287b354844599f911ff2..4d41c9e4cd4531152ceed5d305c56a932a3555a8
--- a/paperclip-addon/plugins/knowledge-base/package.json
+++ b/paperclip-addon/plugins/knowledge-base/package.json
@@ -1,7 +1,7 @@
 {
   "name": "@insightflo/paperclip-knowledge-base",
   "version": "0.1.0",
-  "description": "Knowledge Base plugin for Paperclip — register company knowledge sources and grant agent-level access",
+  "description": "Knowledge Base plugin for Paperclip - register company knowledge sources and grant agent-level access",
   "type": "module",
   "private": true,
   "exports": {
diff --git a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
index 9c29afaab5518e5505cfa7e461302e21317ff17f..75d8602bdaf44be999e95f3c8ed00bdd4696554b
--- a/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
+++ b/paperclip-addon/plugins/knowledge-base/src/kb-store.ts
@@ -81,6 +81,8 @@
   data: AgentKBGrantData;
 };
 
+type AgentRecord = Awaited<ReturnType<PluginContext["agents"]["list"]>>[number];
+
 function entities(ctx: PluginContext): EntitiesCompatClient {
   return ctx.entities as unknown as EntitiesCompatClient;
 }
@@ -607,14 +609,16 @@
   companyId: string,
 ): Promise<string[]> {
   const agents = await ctx.agents.list({ companyId, limit: 500, offset: 0 });
+  const names: string[] = [];
+
+  for (const agent of agents as AgentRecord[]) {
+    const name = asNonEmptyString((agent as { name?: unknown }).name);
+    if (name) {
+      names.push(name);
+    }
+  }
 
-  return Array.from(
-    new Set(
-      agents
-        .map((agent) => asNonEmptyString(agent.name))
-        .filter((name) => name.length > 0),
-    ),
-  ).sort((left, right) => left.localeCompare(right));
+  return Array.from(new Set(names)).sort((left, right) => left.localeCompare(right));
 }
 
 export async function getKnowledgeBaseOverview(
diff --git a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
index ffa69da20003abfe5cf4863065413d38aa142a8a..060955a0e2f62f6e181665e8145027b4581c037e
--- a/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
+++ b/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx
@@ -31,6 +31,19 @@
   updatedAt: string;
 };
 
+type KnowledgeBaseDetail = KnowledgeBaseItem & {
+  staticConfig?: {
+    content: string;
+  };
+  ragConfig?: {
+    mcpServerUrl?: string;
+    topK?: number;
+  };
+  ontologyConfig?: {
+    kgPath?: string;
+  };
+};
+
 type KnowledgeBaseGrant = {
   id: string;
   agentName: string;
@@ -176,6 +189,11 @@
     companyId,
     refreshNonce,
   });
+  const selectedDetail = usePluginData<KnowledgeBaseDetail | null>(DATA_KEYS.kbGet, {
+    companyId,
+    id: selectedKbId,
+    refreshNonce,
+  });
 
   const createKnowledgeBase = usePluginAction(ACTION_KEYS.kbCreate);
   const updateKnowledgeBase = usePluginAction(ACTION_KEYS.kbUpdate);
@@ -204,6 +222,14 @@
   );
 
   useEffect(() => {
+    const detail = selectedDetail.data;
+    if (detail) {
+      setDetailDescription(detail.description ?? "");
+      setDetailTokenBudget(String(detail.maxTokenBudget || 4096));
+      setDetailStaticContent(detail.staticConfig?.content ?? "");
+      return;
+    }
+
     if (!selectedKnowledgeBase) {
       return;
     }
@@ -211,10 +237,18 @@
     setDetailDescription(selectedKnowledgeBase.description ?? "");
     setDetailTokenBudget(String(selectedKnowledgeBase.maxTokenBudget || 4096));
 
-    if (selectedKnowledgeBase.type !== KB_TYPES.static) {
-      setDetailStaticContent("");
+    setDetailStaticContent("");
+  }, [selectedDetail.data, selectedKnowledgeBase]);
+
+  useEffect(() => {
+    if (!selectedKnowledgeBase) {
+      return;
+    }
+
+    if (!grantKbName) {
+      setGrantKbName(selectedKnowledgeBase.name);
     }
-  }, [selectedKnowledgeBase]);
+  }, [grantKbName, selectedKnowledgeBase]);
 
   const selectedKbGrants = useMemo(
     () => grants.filter((grant) => grant.kbName === selectedKnowledgeBase?.name),

tokens used
367,076
구현 완료했습니다. `plugins/knowledge-base`에 요청하신 전체 파일을 생성했고, `workflow-engine` 구조를 맞춰 구성했습니다.

- 생성 파일
  - [package.json](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/package.json)
  - [tsconfig.json](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/tsconfig.json)
  - [scripts/build-ui.mjs](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/scripts/build-ui.mjs)
  - [constants.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/constants.ts)
  - [index.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/index.ts)
  - [manifest.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/manifest.ts)
  - [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts)
  - [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts)
  - [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx)

핵심 반영 사항:

- `ctx.entities` 기반 KB/Grant CRUD 구현: [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts:49)
- `AgentKBGrant`를 `agentName + kbName` 기준으로 관리 (ID 하드코딩 없음): [kb-store.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/kb-store.ts:529)
- `agent.run.started`에서 `agentId -> agentName` resolve 후 KB 주입:
  - 이벤트 처리: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:418)
  - 주입 포맷 `## 참조 지식: {KB name}\n{content}`: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:468)
  - `rag/ontology`는 현재 로그만 남기도록 처리: [worker.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/worker.ts:474)
- UI에 KB 목록/상세(static 편집)/에이전트 매핑/사이드바 링크 구현:
  - 페이지: [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx:166)
  - 사이드바: [ui/index.tsx](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/ui/index.tsx:644)
- Manifest capability + page/sidebar 슬롯 등록: [manifest.ts](/Users/kwak/Projects/paperclip/paperclip-addon/plugins/knowledge-base/src/manifest.ts:10)

검증:

- 실행: `pnpm -C plugins/knowledge-base typecheck`
- 결과: 실패 (현재 폴더에 `node_modules`가 없어 `@paperclipai/plugin-sdk`, `react`를 해석하지 못함).  
  즉, 현재 실패는 환경 의존성 부재가 주원인입니다.
