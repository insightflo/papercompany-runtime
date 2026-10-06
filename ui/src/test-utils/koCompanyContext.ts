import type { ContextType } from "react";
import { CompanyContext } from "../context/CompanyContext";

export const koCompanyContext = {
  companies: [], selectedCompanyId: "company", selectionSource: "bootstrap", loading: false, error: null,
  selectedCompany: {
    id: "company", name: "Company", description: null, status: "active", pauseReason: null, pausedAt: null,
    issuePrefix: "CO", issueCounter: 0, budgetMonthlyCents: 0, spentMonthlyCents: 0,
    requireBoardApprovalForNewAgents: false, brandColor: null, logoAssetId: null, logoUrl: null,
    timezone: null, workProductRoot: null, defaultLanguage: "ko", createdAt: new Date(), updatedAt: new Date(),
  },
  setSelectedCompanyId: () => {}, reloadCompanies: async () => {},
  createCompany: async () => { throw new Error("unused"); },
} satisfies NonNullable<ContextType<typeof CompanyContext>>;
