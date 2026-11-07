/**
 * Domain client surfaces for the Paperclip plugin worker-side SDK
 * (`ctx.issues`, `ctx.agents`, `ctx.goals`, `ctx.approvals`, and agent sessions).
 *
 * Split out of `types.ts` (#T16d) so both modules stay under the 1000-line limit.
 * Every declaration here is re-exported from `./types.js`, so the public
 * `@paperclipai/plugin-sdk/types` surface is unchanged.
 */

import type {
  Issue,
  IssueComment,
  IssueDocument,
  IssueDocumentSummary,
  Agent,
  Goal,
  Approval,
  ApprovalType,
} from "@paperclipai/shared";

/**
 * `ctx.issues.documents` — read and write issue documents.
 *
 * Requires:
 * - `issue.documents.read` for `list` and `get`
 * - `issue.documents.write` for `upsert` and `delete`
 *
 * @see PLUGIN_SPEC.md §14 — SDK Surface
 */
export interface PluginIssueDocumentsClient {
  /**
   * List all documents attached to an issue.
   *
   * Returns summary metadata (id, key, title, format, timestamps) without
   * the full document body. Use `get()` to fetch a specific document's body.
   *
   * Requires the `issue.documents.read` capability.
   */
  list(issueId: string, companyId: string): Promise<IssueDocumentSummary[]>;

  /**
   * Get a single document by key, including its full body content.
   *
   * Returns `null` if no document exists with the given key.
   *
   * Requires the `issue.documents.read` capability.
   *
   * @param issueId - UUID of the issue
   * @param key - Document key (e.g. `"plan"`, `"design-spec"`)
   * @param companyId - UUID of the company
   */
  get(issueId: string, key: string, companyId: string): Promise<IssueDocument | null>;

  /**
   * Create or update a document on an issue.
   *
   * If a document with the given key already exists, it is updated and a new
   * revision is created. If it does not exist, it is created.
   *
   * Requires the `issue.documents.write` capability.
   *
   * @param input - Document data including issueId, key, body, and optional title/format/changeSummary
   */
  upsert(input: {
    issueId: string;
    key: string;
    body: string;
    companyId: string;
    title?: string;
    format?: string;
    changeSummary?: string;
  }): Promise<IssueDocument>;

  /**
   * Delete a document and all its revisions.
   *
   * No-ops silently if the document does not exist (idempotent).
   *
   * Requires the `issue.documents.write` capability.
   *
   * @param issueId - UUID of the issue
   * @param key - Document key to delete
   * @param companyId - UUID of the company
   */
  delete(issueId: string, key: string, companyId: string): Promise<void>;
}

/**
 * `ctx.issues` — read and mutate issues plus comments.
 *
 * Requires:
 * - `issues.read` for read operations
 * - `issues.create` for create
 * - `issues.update` for update
 * - `issue.comments.read` for `listComments`
 * - `issue.comments.create` for `createComment`
 * - `issue.documents.read` for `documents.list` and `documents.get`
 * - `issue.documents.write` for `documents.upsert` and `documents.delete`
 */
export interface PluginIssuesClient {
  list(input: {
    companyId: string;
    projectId?: string;
    assigneeAgentId?: string;
    status?: Issue["status"];
    limit?: number;
    offset?: number;
  }): Promise<Issue[]>;
  get(issueId: string, companyId: string): Promise<Issue | null>;
  create(input: {
    companyId: string;
    projectId?: string;
    goalId?: string;
    parentId?: string;
    title: string;
    description?: string;
    status?: Issue["status"];
    priority?: Issue["priority"];
    assigneeAgentId?: string;
  }): Promise<Issue>;
  update(
    issueId: string,
    patch: Partial<Pick<
      Issue,
      "title" | "description" | "status" | "priority" | "assigneeAgentId"
    >>,
    companyId: string,
  ): Promise<Issue>;
  listComments(issueId: string, companyId: string): Promise<IssueComment[]>;
  createComment(issueId: string, body: string, companyId: string): Promise<IssueComment>;
  /** Read and write issue documents. Requires `issue.documents.read` / `issue.documents.write`. */
  documents: PluginIssueDocumentsClient;
}

/**
 * `ctx.agents` — read and manage agents.
 *
 * Requires `agents.read` for reads; `agents.pause` / `agents.resume` /
 * `agents.invoke` for write operations.
 */
export interface PluginAgentsClient {
  list(input: { companyId: string; status?: Agent["status"]; limit?: number; offset?: number }): Promise<Agent[]>;
  get(agentId: string, companyId: string): Promise<Agent | null>;
  /** Pause an agent. Throws if agent is terminated or not found. Requires `agents.pause`. */
  pause(agentId: string, companyId: string): Promise<Agent>;
  /** Resume a paused agent (sets status to idle). Throws if terminated, pending_approval, or not found. Requires `agents.resume`. */
  resume(agentId: string, companyId: string): Promise<Agent>;
  /** Invoke (wake up) an agent with a prompt payload. Throws if paused, terminated, pending_approval, or not found. Requires `agents.invoke`. */
  invoke(agentId: string, companyId: string, opts: { prompt: string; reason?: string }): Promise<{ runId: string }>;
  /** Create, message, and close agent chat sessions. Requires `agent.sessions.*` capabilities. */
  sessions: PluginAgentSessionsClient;
}

// ---------------------------------------------------------------------------
// Agent Sessions — two-way chat with agents
// ---------------------------------------------------------------------------

/**
 * Represents an active conversational session with an agent.
 * Maps to an `AgentTaskSession` row on the host.
 */
export interface AgentSession {
  sessionId: string;
  agentId: string;
  companyId: string;
  status: "active" | "closed";
  createdAt: string;
}

/**
 * A streaming event received during a session's `sendMessage` call.
 * Delivered via JSON-RPC notifications from host to worker.
 */
export interface AgentSessionEvent {
  sessionId: string;
  runId: string;
  seq: number;
  /** The kind of event: "chunk" for output data, "status" for run state changes, "done" for end-of-stream, "error" for failures. */
  eventType: "chunk" | "status" | "done" | "error";
  stream: "stdout" | "stderr" | "system" | null;
  message: string | null;
  payload: Record<string, unknown> | null;
}

/**
 * Result of sending a message to a session.
 */
export interface AgentSessionSendResult {
  runId: string;
}

/**
 * `ctx.agents.sessions` — create, message, and close agent chat sessions.
 *
 * Requires `agent.sessions.create` for create, `agent.sessions.list` for list,
 * `agent.sessions.send` for sendMessage, `agent.sessions.close` for close.
 */
export interface PluginAgentSessionsClient {
  /** Create a new conversational session with an agent. Requires `agent.sessions.create`. */
  create(agentId: string, companyId: string, opts?: {
    taskKey?: string;
    reason?: string;
  }): Promise<AgentSession>;

  /** List active sessions for an agent owned by this plugin. Requires `agent.sessions.list`. */
  list(agentId: string, companyId: string): Promise<AgentSession[]>;

  /**
   * Send a message to a session and receive streaming events via the `onEvent` callback.
   * Returns immediately with `{ runId }`. Events are delivered asynchronously.
   * Requires `agent.sessions.send`.
   */
  sendMessage(sessionId: string, companyId: string, opts: {
    prompt: string;
    reason?: string;
    onEvent?: (event: AgentSessionEvent) => void;
  }): Promise<AgentSessionSendResult>;

  /** Close a session, releasing resources. Requires `agent.sessions.close`. */
  close(sessionId: string, companyId: string): Promise<void>;
}

/**
 * `ctx.goals` — read and mutate goals.
 *
 * Requires:
 * - `goals.read` for read operations
 * - `goals.create` for create
 * - `goals.update` for update
 */
export interface PluginGoalsClient {
  list(input: {
    companyId: string;
    level?: Goal["level"];
    status?: Goal["status"];
    limit?: number;
    offset?: number;
  }): Promise<Goal[]>;
  get(goalId: string, companyId: string): Promise<Goal | null>;
  create(input: {
    companyId: string;
    title: string;
    description?: string;
    level?: Goal["level"];
    status?: Goal["status"];
    parentId?: string;
    ownerAgentId?: string;
  }): Promise<Goal>;
  update(
    goalId: string,
    patch: Partial<Pick<
      Goal,
      "title" | "description" | "level" | "status" | "parentId" | "ownerAgentId"
    >>,
    companyId: string,
  ): Promise<Goal>;
}

/**
 * `ctx.approvals` — create generic Human Operator approvals.
 *
 * Requires the `approvals.create` capability. The host records the requesting
 * plugin id on the approval so it receives the generic `approval.decided`
 * resolution event for its own approvals.
 */
export interface PluginApprovalsClient {
  /**
   * Create a pending generic approval. The Human Operator resolves it through
   * the standard approvals surface. The `type` must be a supported generic
   * approval type (e.g. `"external_automation"`).
   *
   * The plugin subscribes to `approval.decided` and filters by
   * `payload.sourcePluginId === <this plugin id>` to learn the outcome.
   */
  create(input: {
    companyId: string;
    type: ApprovalType;
    payload: Record<string, unknown>;
    title?: string;
    summary?: string;
  }): Promise<Approval>;
}
