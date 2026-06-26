import type {
  HermesChatPageContext,
  HermesChatAttachment,
  HermesChatSendMessageResult,
  HermesChatSession,
  HermesChatSessionDetail,
  AdapterEnvironmentTestResult,
} from "@paperclipai/shared";
import { api } from "./client";

function base(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/hermes-chat`;
}

export interface HermesOperationsAgentEnsureResult {
  id: string;
  name: string;
  status: string;
  adapterType: string;
  autoProvisionedNow: boolean;
}

export interface HermesOperationsAgentStatusResult {
  configured: boolean;
  agent: HermesOperationsAgentEnsureResult | null;
  environment: AdapterEnvironmentTestResult;
}

export const hermesChatApi = {
  getOperationsAgent: (companyId: string) =>
    api.get<HermesOperationsAgentStatusResult>(`${base(companyId)}/operations-agent`),
  ensureOperationsAgent: (companyId: string) =>
    api.post<HermesOperationsAgentEnsureResult>(`${base(companyId)}/operations-agent`, {}),
  listSessions: (companyId: string) =>
    api.get<HermesChatSession[]>(`${base(companyId)}/sessions`),
  createSession: (companyId: string, data: { title?: string | null } = {}) =>
    api.post<HermesChatSession>(`${base(companyId)}/sessions`, data),
  getSession: (companyId: string, sessionId: string) =>
    api.get<HermesChatSessionDetail>(`${base(companyId)}/sessions/${encodeURIComponent(sessionId)}`),
  updateSession: (
    companyId: string,
    sessionId: string,
    data: { title?: string | null; status?: "active" | "archived" },
  ) =>
    api.patch<HermesChatSession>(`${base(companyId)}/sessions/${encodeURIComponent(sessionId)}`, data),
  sendMessage: (
    companyId: string,
    sessionId: string,
    data: {
      body: string;
      forceFreshSession?: boolean;
      pageContext?: HermesChatPageContext | null;
      attachments?: HermesChatAttachment[];
    },
  ) =>
    api.post<HermesChatSendMessageResult>(
      `${base(companyId)}/sessions/${encodeURIComponent(sessionId)}/messages`,
      data,
    ),
};
