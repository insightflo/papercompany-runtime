import type { CompanyWorkProductStorageConfig } from "@paperclipai/shared/validators/company-work-product-storage";
import { api } from "./client";

export type WorkProductStorageConnectionTest = {
  ok: boolean;
  provider: "local_disk" | "s3";
  error?: string;
};

export const workProductStorageApi = {
  get: (companyId: string) =>
    api.get<CompanyWorkProductStorageConfig>(`/companies/${companyId}/work-product-storage`),
  save: (companyId: string, config: CompanyWorkProductStorageConfig) =>
    api.put<CompanyWorkProductStorageConfig>(`/companies/${companyId}/work-product-storage`, config),
  test: (companyId: string) =>
    api.post<WorkProductStorageConnectionTest>(`/companies/${companyId}/work-product-storage/test`, {}),
};
