import type {
  HermesChatPageContext,
  HermesChatAttachment,
  HermesChatSendMessageResult,
  HermesChatSession,
  HermesChatSessionDetail,
} from "@paperclipai/shared";
import { api } from "./client";

function base(companyId: string) {
  return `/companies/${encodeURIComponent(companyId)}/hermes-chat`;
}

export const hermesChatApi = {
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
