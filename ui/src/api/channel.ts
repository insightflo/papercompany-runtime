import { api } from "./client";

/**
 * Channel config for a company (one record per kind, kind="telegram" for now).
 */
export interface ChannelConfig {
  id: string;
  companyId: string;
  kind: "telegram";
  /** Telegram-specific fields inside configJson */
  botUsername: string | null;
  botTokenSecretId: string | null;
  enabled: boolean;
  createdAt: string;
}

export interface UpdateChannelConfigInput {
  botUsername?: string;
  botTokenSecretId?: string;
  enabled?: boolean;
}

export interface ChannelTestResult {
  ok: boolean;
  botUsername?: string;
  error?: string;
}

export const channelApi = {
  getConfig: (companyId: string) =>
    api.get<ChannelConfig | null>(`/companies/${companyId}/channel/config`),
  updateConfig: (companyId: string, data: UpdateChannelConfigInput) =>
    api.put<ChannelConfig>(`/companies/${companyId}/channel/config`, data),
  test: (companyId: string) =>
    api.post<ChannelTestResult>(`/companies/${companyId}/channel/test`, {}),
};
