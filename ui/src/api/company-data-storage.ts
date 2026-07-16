import type { CompanyDataStorageConfig } from "@paperclipai/shared/validators/company-data-storage";
import { api } from "./client";

export type DataStorageConnectionTest = {
  ok: boolean;
  provider: "local_disk" | "s3";
  error?: string;
};

export const dataStorageApi = {
  get: (companyId: string) =>
    api.get<CompanyDataStorageConfig>(`/companies/${companyId}/data-storage`),
  save: (companyId: string, config: CompanyDataStorageConfig) =>
    api.put<CompanyDataStorageConfig>(`/companies/${companyId}/data-storage`, config),
  test: (companyId: string) =>
    api.post<DataStorageConnectionTest>(`/companies/${companyId}/data-storage/test`, {}),
};
