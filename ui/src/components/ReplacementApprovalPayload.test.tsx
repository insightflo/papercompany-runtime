import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Approval } from "@paperclipai/shared";
import { ReplacementApprovalPayload } from "./ReplacementApprovalPayload";
import { approvalHumanReview } from "../lib/humanReview";
import { CompanyLanguageProvider } from "../lib/companyLanguage";
const uuid = "00000000-0000-4000-8000-000000000001";
const payload = { schemaVersion: 1, companyId: uuid, missionId: uuid, workflowId: uuid,
  sourceRunId: uuid, sourceAuthorityVersion: 0, terminalDecisionId: uuid, decisionEventId: uuid,
  requesterAgentId: uuid, targetRunId: "00000000-0000-4000-8000-000000000002", requestGeneration: 0,
  stepRunId: uuid, definitionHash: "a".repeat(64), inputHash: "b".repeat(64), metadata: { day: "2026-09-30" },
  idempotencyKey: "explicit-restart", externalEffects: "operator_reconciled" };
const approval: Approval = { id: uuid, companyId: uuid, type: "workflow_replacement", payload,
  requestedByAgentId: null, requestedByUserId: "board", requestedByPluginId: null, status: "pending",
  decisionNote: null, decidedByUserId: null, decidedAt: null, createdAt: new Date(), updatedAt: new Date() };
describe("replacement approval packet", () => {
  it("shows exact source, reserved target, hashes, generation zero and reconciliation limits", () => {
    const html = renderToStaticMarkup(<CompanyLanguageProvider language="ko"><ReplacementApprovalPayload payload={payload} /></CompanyLanguageProvider>);
    for (const text of [payload.sourceRunId, payload.targetRunId, payload.definitionHash, payload.inputHash, "0 / 0", "외부 상태 자동 검증 아님", "2026-09-30"]) expect(html).toContain(text);
    const packet = approvalHumanReview(approval);
    expect(packet?.requiredReviewer).toBe("해당 회사의 보드 운영자");
    expect(packet?.evidence[0].href).toBe(`/missions/${uuid}`);
  });
  it("malformed packets cannot become approvable", () => {
    expect(approvalHumanReview({ ...approval, payload: {} })).toBeNull();
    expect(renderToStaticMarkup(<CompanyLanguageProvider language="ko"><ReplacementApprovalPayload payload={{}} /></CompanyLanguageProvider>)).toContain("유효하지 않습니다");
  });
});
