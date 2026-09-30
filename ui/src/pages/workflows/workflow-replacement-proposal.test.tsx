// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter, useLocation } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { WorkflowReplacementProposal } from "./workflow-replacement-proposal";
import { workflowReplacementApi } from "./workflow-replacement-api";
vi.mock("./workflow-replacement-api", () => ({ workflowReplacementApi: { propose: vi.fn().mockResolvedValue({ id: "approval" }) } }));
vi.mock("@/context/CompanyContext", () => ({ useCompany: () => ({ selectedCompany: null }) }));
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
function LocationProbe() {
  return <output>{useLocation().pathname}</output>;
}
it.each(["QA", "OTHER"])("preserves %s company scope when reviewing a reconciled proposal without executing", async (prefix) => {
  vi.mocked(workflowReplacementApi.propose).mockClear();
  const runId = "00000000-0000-4000-8000-000000000001", decisionEventId = "00000000-0000-4000-8000-000000000002";
  const container = document.createElement("div"); document.body.appendChild(container); const root = createRoot(container);
  try {
    await act(async () => root.render(<MemoryRouter initialEntries={[`/${prefix}/workflows`]}>
      <WorkflowReplacementProposal companyId="company" runId={runId} />
      <LocationProbe />
    </MemoryRouter>));
    const submit = container.querySelector("button")!;
    expect(submit.disabled).toBe(true);
    const inputs = container.querySelectorAll("input");
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
    await act(async () => {
      setter.call(inputs[0], decisionEventId); inputs[0].dispatchEvent(new Event("input", { bubbles: true }));
      setter.call(inputs[1], "explicit"); inputs[1].dispatchEvent(new Event("input", { bubbles: true }));
      inputs[2].click();
    });
    await act(async () => { submit.click(); });
    expect(workflowReplacementApi.propose).toHaveBeenCalledWith("company", {
      sourceRunId: runId, decisionEventId, idempotencyKey: "explicit", metadata: {}, externalEffects: "operator_reconciled",
    });
    const review = container.querySelector("a")!;
    expect(review.getAttribute("href")).toBe(`/${prefix}/approvals/approval`);
    expect(submit.disabled).toBe(true);
    await act(async () => { review.click(); });
    expect(container.querySelector("output")?.textContent).toBe(`/${prefix}/approvals/approval`);
    expect(workflowReplacementApi.propose).toHaveBeenCalledTimes(1);
  } finally { await act(async () => root.unmount()); container.remove(); }
});
