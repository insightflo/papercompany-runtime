import type { HeartbeatRunStatus } from "../constants.js";

export type HermesChatSessionStatus = "active" | "archived";
export type HermesChatMessageRole = "user" | "assistant" | "system";
export type HermesChatMessageStatus = "sent" | "queued" | "running" | "succeeded" | "failed" | "cancelled" | "timed_out";

export interface HermesChatSession {
  id: string;
  companyId: string;
  agentId: string | null;
  title: string;
  status: HermesChatSessionStatus;
  createdByUserId: string | null;
  lastMessageAt: string | null;
  createdAt: string;
  updatedAt: string;
  messageCount?: number;
  latestRunStatus?: HeartbeatRunStatus | null;
}

export interface HermesChatMessage {
  id: string;
  companyId: string;
  sessionId: string;
  agentId: string | null;
  runId: string | null;
  role: HermesChatMessageRole;
  body: string;
  status: HermesChatMessageStatus;
  metadata: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface HermesChatSessionDetail {
  session: HermesChatSession;
  messages: HermesChatMessage[];
}

export interface HermesChatPageContext {
  kind: string;
  path: string;
  url?: string;
  companyId?: string | null;
  companyName?: string | null;
  companyPrefix?: string | null;
  entityId?: string | null;
  title?: string | null;
  status?: string | null;
  summary?: string | null;
  facts?: Record<string, unknown>;
  loadedAt: string;
}

export interface HermesChatAttachment {
  id: string;
  name: string;
  contentType: string;
  size: number;
  kind: "image" | "file";
  dataUrl?: string;
  text?: string;
}

export interface HermesChatSendMessageResult {
  session: HermesChatSession;
  userMessage: HermesChatMessage;
  assistantMessage: HermesChatMessage | null;
  runId: string | null;
}
