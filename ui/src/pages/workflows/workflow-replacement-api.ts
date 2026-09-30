import type { Approval } from "@paperclipai/shared";
import type { ProposeReplacement } from "@paperclipai/shared/validators/workflow-replacement";
import { coreApiJson } from "./workflow-core-api.js";

// Separate board endpoints: generic approvals cannot authorize replacement execution.
export const workflowReplacementApi = {
  propose: (companyId: string, body: ProposeReplacement) => coreApiJson<Approval>(
    `/companies/${encodeURIComponent(companyId)}/workflow-replacements`, { method: "POST", body: JSON.stringify(body) }),
  approve: (companyId: string, approvalId: string) => coreApiJson<Approval>(
    `/companies/${encodeURIComponent(companyId)}/workflow-replacements/${encodeURIComponent(approvalId)}/approve`,
    { method: "POST", body: JSON.stringify({}) }),
};
