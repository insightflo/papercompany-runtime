/**
 * Host ↔ worker method signature maps for the Paperclip plugin JSON-RPC protocol.
 *
 * Split out of `protocol.ts` (#T16d) so both modules stay under the 1000-line limit.
 * Every declaration here is re-exported from `./protocol.js`, so the public
 * `@paperclipai/plugin-sdk/protocol` surface is unchanged.
 */

import type {
  PaperclipPluginManifestV1,
  PluginLauncherBounds,
  PluginLauncherRenderContextSnapshot,
  PluginStateScopeKind,
  Company,
  Project,
  Issue,
  IssueComment,
  IssueDocument,
  IssueDocumentSummary,
  Agent,
  Goal,
  Approval,
  ApprovalType,
} from "@paperclipai/shared";
import type {
  PluginEvent,
  PluginJobContext,
  PluginWorkspace,
  ToolRunContext,
  ToolResult,
} from "./types.js";
import type {
  PluginHealthDiagnostics,
  PluginConfigValidationResult,
  PluginWebhookInput,
} from "./define-plugin.js";

// ---------------------------------------------------------------------------
// Host → Worker Method Signatures (§13 Host-Worker Protocol)
// ---------------------------------------------------------------------------

/**
 * Input for the `initialize` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.1 — `initialize`
 */
export interface InitializeParams {
  /** Full plugin manifest snapshot. */
  manifest: PaperclipPluginManifestV1;
  /** Resolved operator configuration (validated against `instanceConfigSchema`). */
  config: Record<string, unknown>;
  /** Instance-level metadata. */
  instanceInfo: {
    /** UUID of this Paperclip instance. */
    instanceId: string;
    /** Semver version of the running Paperclip host. */
    hostVersion: string;
  };
  /** Host API version. */
  apiVersion: number;
}

/**
 * Result returned by the `initialize` RPC method.
 */
export interface InitializeResult {
  /** Whether initialization succeeded. */
  ok: boolean;
  /** Optional methods the worker has implemented (e.g. "validateConfig", "onEvent"). */
  supportedMethods?: string[];
}

/**
 * Input for the `configChanged` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.4 — `configChanged`
 */
export interface ConfigChangedParams {
  /** The newly resolved configuration. */
  config: Record<string, unknown>;
}

/**
 * Input for the `validateConfig` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.3 — `validateConfig`
 */
export interface ValidateConfigParams {
  /** The configuration to validate. */
  config: Record<string, unknown>;
}

/**
 * Input for the `onEvent` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.5 — `onEvent`
 */
export interface OnEventParams {
  /** The domain event to deliver. */
  event: PluginEvent;
}

/**
 * Input for the `runJob` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.6 — `runJob`
 */
export interface RunJobParams {
  /** Job execution context. */
  job: PluginJobContext;
}

/**
 * Input for the `getData` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.8 — `getData`
 */
export interface GetDataParams {
  /** Plugin-defined data key (e.g. `"sync-health"`). */
  key: string;
  /** Context and query parameters from the UI. */
  params: Record<string, unknown>;
  /** Optional launcher/container metadata from the host render environment. */
  renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
}

/**
 * Input for the `performAction` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.9 — `performAction`
 */
export interface PerformActionParams {
  /** Plugin-defined action key (e.g. `"resync"`). */
  key: string;
  /** Action parameters from the UI. */
  params: Record<string, unknown>;
  /** Optional launcher/container metadata from the host render environment. */
  renderEnvironment?: PluginLauncherRenderContextSnapshot | null;
}

/**
 * Input for the `executeTool` RPC method.
 *
 * @see PLUGIN_SPEC.md §13.10 — `executeTool`
 */
export interface ExecuteToolParams {
  /** Tool name (without plugin namespace prefix). */
  toolName: string;
  /** Parsed parameters matching the tool's declared schema. */
  parameters: unknown;
  /** Agent run context. */
  runContext: ToolRunContext;
}

// ---------------------------------------------------------------------------
// UI launcher / modal host interaction payloads
// ---------------------------------------------------------------------------

/**
 * Bounds request issued by a plugin UI running inside a host-managed launcher
 * container such as a modal, drawer, or popover.
 */
export interface PluginModalBoundsRequest {
  /** High-level size preset requested from the host. */
  bounds: PluginLauncherBounds;
  /** Optional explicit width override in CSS pixels. */
  width?: number;
  /** Optional explicit height override in CSS pixels. */
  height?: number;
  /** Optional lower bounds for host resizing decisions. */
  minWidth?: number;
  minHeight?: number;
  /** Optional upper bounds for host resizing decisions. */
  maxWidth?: number;
  maxHeight?: number;
}

/**
 * Reason metadata supplied by host-managed close lifecycle callbacks.
 */
export interface PluginRenderCloseEvent {
  reason:
    | "escapeKey"
    | "backdrop"
    | "hostNavigation"
    | "programmatic"
    | "submit"
    | "unknown";
  nativeEvent?: unknown;
}

/**
 * Map of host→worker RPC method names to their `[params, result]` types.
 *
 * This type is the single source of truth for all methods the host can call
 * on a worker. Used by both the host dispatcher and the worker handler to
 * ensure type safety across the IPC boundary.
 */
export interface HostToWorkerMethods {
  /** @see PLUGIN_SPEC.md §13.1 */
  initialize: [params: InitializeParams, result: InitializeResult];
  /** @see PLUGIN_SPEC.md §13.2 */
  health: [params: Record<string, never>, result: PluginHealthDiagnostics];
  /** @see PLUGIN_SPEC.md §12.5 */
  shutdown: [params: Record<string, never>, result: void];
  /** @see PLUGIN_SPEC.md §13.3 */
  validateConfig: [params: ValidateConfigParams, result: PluginConfigValidationResult];
  /** @see PLUGIN_SPEC.md §13.4 */
  configChanged: [params: ConfigChangedParams, result: void];
  /** @see PLUGIN_SPEC.md §13.5 */
  onEvent: [params: OnEventParams, result: void];
  /** @see PLUGIN_SPEC.md §13.6 */
  runJob: [params: RunJobParams, result: void];
  /** @see PLUGIN_SPEC.md §13.7 */
  handleWebhook: [params: PluginWebhookInput, result: void];
  /** @see PLUGIN_SPEC.md §13.8 */
  getData: [params: GetDataParams, result: unknown];
  /** @see PLUGIN_SPEC.md §13.9 */
  performAction: [params: PerformActionParams, result: unknown];
  /** @see PLUGIN_SPEC.md §13.10 */
  executeTool: [params: ExecuteToolParams, result: ToolResult];
}

/** Union of all host→worker method names. */
export type HostToWorkerMethodName = keyof HostToWorkerMethods;

/** Required methods the worker MUST implement. */
export const HOST_TO_WORKER_REQUIRED_METHODS: readonly HostToWorkerMethodName[] = [
  "initialize",
  "health",
  "shutdown",
] as const;

/** Optional methods the worker MAY implement. */
export const HOST_TO_WORKER_OPTIONAL_METHODS: readonly HostToWorkerMethodName[] = [
  "validateConfig",
  "configChanged",
  "onEvent",
  "runJob",
  "handleWebhook",
  "getData",
  "performAction",
  "executeTool",
] as const;

// ---------------------------------------------------------------------------
// Worker → Host Method Signatures (SDK client calls)
// ---------------------------------------------------------------------------

/**
 * Map of worker→host RPC method names to their `[params, result]` types.
 *
 * These represent the SDK client calls that the worker makes back to the
 * host to access platform services (state, entities, config, etc.).
 */
export interface WorkerToHostMethods {
  // Config
  "config.get": [params: Record<string, never>, result: Record<string, unknown>];

  // State
  "state.get": [
    params: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string },
    result: unknown,
  ];
  "state.set": [
    params: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string; value: unknown },
    result: void,
  ];
  "state.delete": [
    params: { scopeKind: string; scopeId?: string; namespace?: string; stateKey: string },
    result: void,
  ];

  // Entities
  "entities.upsert": [
    params: {
      entityType: string;
      scopeKind: PluginStateScopeKind;
      scopeId?: string;
      externalId?: string;
      title?: string;
      status?: string;
      data: Record<string, unknown>;
    },
    result: {
      id: string;
      entityType: string;
      scopeKind: PluginStateScopeKind;
      scopeId: string | null;
      externalId: string | null;
      title: string | null;
      status: string | null;
      data: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    },
  ];
  "entities.list": [
    params: {
      entityType?: string;
      scopeKind?: PluginStateScopeKind;
      scopeId?: string;
      externalId?: string;
      limit?: number;
      offset?: number;
    },
    result: Array<{
      id: string;
      entityType: string;
      scopeKind: PluginStateScopeKind;
      scopeId: string | null;
      externalId: string | null;
      title: string | null;
      status: string | null;
      data: Record<string, unknown>;
      createdAt: string;
      updatedAt: string;
    }>,
  ];

  // Events
  "events.emit": [
    params: { name: string; companyId: string; payload: unknown },
    result: void,
  ];
  "events.subscribe": [
    params: { eventPattern: string; filter?: Record<string, unknown> | null },
    result: void,
  ];

  // HTTP
  "http.fetch": [
    params: { url: string; init?: Record<string, unknown> },
    result: { status: number; statusText: string; headers: Record<string, string>; body: string },
  ];

  // Secrets
  "secrets.resolve": [
    params: { secretRef: string },
    result: string,
  ];

  // Activity
  "activity.log": [
    params: {
      companyId: string;
      message: string;
      entityType?: string;
      entityId?: string;
      metadata?: Record<string, unknown>;
    },
    result: void,
  ];

  // Metrics
  "metrics.write": [
    params: { name: string; value: number; tags?: Record<string, string> },
    result: void,
  ];

  // Logger
  "log": [
    params: { level: "info" | "warn" | "error" | "debug"; message: string; meta?: Record<string, unknown> },
    result: void,
  ];

  // Companies (read)
  "companies.list": [
    params: { limit?: number; offset?: number },
    result: Company[],
  ];
  "companies.get": [
    params: { companyId: string },
    result: Company | null,
  ];

  // Projects (read)
  "projects.list": [
    params: { companyId: string; limit?: number; offset?: number },
    result: Project[],
  ];
  "projects.get": [
    params: { projectId: string; companyId: string },
    result: Project | null,
  ];
  "projects.listWorkspaces": [
    params: { projectId: string; companyId: string },
    result: PluginWorkspace[],
  ];
  "projects.getPrimaryWorkspace": [
    params: { projectId: string; companyId: string },
    result: PluginWorkspace | null,
  ];
  "projects.getWorkspaceForIssue": [
    params: { issueId: string; companyId: string },
    result: PluginWorkspace | null,
  ];

  // Issues
  "issues.list": [
    params: {
      companyId: string;
      projectId?: string;
      assigneeAgentId?: string;
      status?: string;
      limit?: number;
      offset?: number;
    },
    result: Issue[],
  ];
  "issues.get": [
    params: { issueId: string; companyId: string },
    result: Issue | null,
  ];
  "issues.create": [
    params: {
      companyId: string;
      projectId?: string;
      goalId?: string;
      parentId?: string;
      title: string;
      description?: string;
      status?: string;
      priority?: string;
      assigneeAgentId?: string;
    },
    result: Issue,
  ];
  "issues.update": [
    params: {
      issueId: string;
      patch: Record<string, unknown>;
      companyId: string;
    },
    result: Issue,
  ];
  "issues.listComments": [
    params: { issueId: string; companyId: string },
    result: IssueComment[],
  ];
  "issues.createComment": [
    params: { issueId: string; body: string; companyId: string },
    result: IssueComment,
  ];

  // Issue Documents
  "issues.documents.list": [
    params: { issueId: string; companyId: string },
    result: IssueDocumentSummary[],
  ];
  "issues.documents.get": [
    params: { issueId: string; key: string; companyId: string },
    result: IssueDocument | null,
  ];
  "issues.documents.upsert": [
    params: {
      issueId: string;
      key: string;
      body: string;
      companyId: string;
      title?: string;
      format?: string;
      changeSummary?: string;
    },
    result: IssueDocument,
  ];
  "issues.documents.delete": [
    params: { issueId: string; key: string; companyId: string },
    result: void,
  ];

  // Agents (read)
  "agents.list": [
    params: { companyId: string; status?: string; limit?: number; offset?: number },
    result: Agent[],
  ];
  "agents.get": [
    params: { agentId: string; companyId: string },
    result: Agent | null,
  ];

  // Agents (write)
  "agents.pause": [
    params: { agentId: string; companyId: string },
    result: Agent,
  ];
  "agents.resume": [
    params: { agentId: string; companyId: string },
    result: Agent,
  ];
  "agents.invoke": [
    params: { agentId: string; companyId: string; prompt: string; reason?: string },
    result: { runId: string },
  ];

  // Agent Sessions
  "agents.sessions.create": [
    params: { agentId: string; companyId: string; taskKey?: string; reason?: string },
    result: { sessionId: string; agentId: string; companyId: string; status: "active" | "closed"; createdAt: string },
  ];
  "agents.sessions.list": [
    params: { agentId: string; companyId: string },
    result: Array<{ sessionId: string; agentId: string; companyId: string; status: "active" | "closed"; createdAt: string }>,
  ];
  "agents.sessions.sendMessage": [
    params: { sessionId: string; companyId: string; prompt: string; reason?: string },
    result: { runId: string },
  ];
  "agents.sessions.close": [
    params: { sessionId: string; companyId: string },
    result: void,
  ];

  // Goals
  "goals.list": [
    params: { companyId: string; level?: string; status?: string; limit?: number; offset?: number },
    result: Goal[],
  ];
  "goals.get": [
    params: { goalId: string; companyId: string },
    result: Goal | null,
  ];
  "goals.create": [
    params: {
      companyId: string;
      title: string;
      description?: string;
      level?: string;
      status?: string;
      parentId?: string;
      ownerAgentId?: string;
    },
    result: Goal,
  ];
  "goals.update": [
    params: {
      goalId: string;
      patch: Record<string, unknown>;
      companyId: string;
    },
    result: Goal,
  ];
  // Approvals
  "approvals.create": [
    params: {
      companyId: string;
      type: ApprovalType;
      payload: Record<string, unknown>;
      title?: string;
      summary?: string;
    },
    result: Approval,
  ];
}

/** Union of all worker→host method names. */
export type WorkerToHostMethodName = keyof WorkerToHostMethods;

// ---------------------------------------------------------------------------
// Worker→Host Notification Types (fire-and-forget, no response)
// ---------------------------------------------------------------------------

/**
 * Typed parameter shapes for worker→host JSON-RPC notifications.
 *
 * Notifications are fire-and-forget — the worker does not wait for a response.
 * These are used for streaming events and logging, not for request-response RPCs.
 */
export interface WorkerToHostNotifications {
  /**
   * Forward a stream event to connected SSE clients.
   *
   * Emitted by the worker for each event on a stream channel. The host
   * publishes to the PluginStreamBus, which fans out to all SSE clients
   * subscribed to the (pluginId, channel, companyId) tuple.
   *
   * The `event` payload is JSON-serializable and sent as SSE `data:`.
   * The default SSE event type is `"message"`.
   */
  "streams.emit": {
    channel: string;
    companyId: string;
    event: unknown;
  };

  /**
   * Signal that a stream channel has been opened.
   *
   * Emitted when the worker calls `ctx.streams.open(channel, companyId)`.
   * UI clients may use this to display a "connected" indicator or begin
   * buffering input. The host tracks open channels so it can emit synthetic
   * close events if the worker crashes.
   */
  "streams.open": {
    channel: string;
    companyId: string;
  };

  /**
   * Signal that a stream channel has been closed.
   *
   * Emitted when the worker calls `ctx.streams.close(channel)`, or
   * synthetically by the host when a worker process exits with channels
   * still open. UI clients should treat this as terminal and disconnect
   * the SSE connection.
   */
  "streams.close": {
    channel: string;
    companyId: string;
  };
}

/** Union of all worker→host notification method names. */
export type WorkerToHostNotificationName = keyof WorkerToHostNotifications;
