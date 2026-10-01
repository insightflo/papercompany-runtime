/** @vitest-environment jsdom */
import { act, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DialogProvider, useDialog } from "../context/DialogContext";
import { NewMissionDialog } from "./NewMissionDialog";
import { missionsApi } from "../api/missions";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock("../api/missions", () => ({ missionsApi: { create: vi.fn(async () => ({ id: "revision" })) } }));
vi.mock("../api/agents", () => ({ agentsApi: { list: vi.fn(async () => [{ id: "owner", name: "Owner" }]) } }));
vi.mock("../api/projects", () => ({ projectsApi: { list: vi.fn(async () => []) } }));
vi.mock("../context/CompanyContext", () => ({ useCompany: () => ({ selectedCompanyId: "company", selectedCompany: { name: "Company" } }) }));
vi.mock("./MarkdownEditor", () => ({ MarkdownEditor: () => <textarea /> }));
vi.mock("@/components/ui/dialog", () => ({ Dialog: ({ children, open }: { children: ReactNode; open: boolean }) => open ? <div>{children}</div> : null,
  DialogContent: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ui/popover", () => ({ Popover: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <div>{children}</div>, PopoverContent: () => null }));

function Opener() {
  const { openNewMission } = useDialog();
  return <button onClick={() => openNewMission({ title: "Revision", ownerAgentId: "owner", description: "Editable request",
    sourceMissionId: "46d4f193-f32c-4adc-94ce-5514fb4a2a27", sourceWorkflowRunId: "963ff8de-1847-4968-8b72-a59d5987ef4e" })}>Open revision</button>;
}

describe("NewMissionDialog revision IDs", () => {
  it("sends structured IDs from the real DialogContext, independent of editable prose", async () => {
    const host = document.createElement("div"); document.body.appendChild(host);
    const root = createRoot(host);
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    try {
      await act(async () => { root.render(<QueryClientProvider client={client}><DialogProvider><Opener /><NewMissionDialog /></DialogProvider></QueryClientProvider>); });
      await act(async () => { host.querySelector("button")!.click(); });
      await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); });
      const submit = [...host.querySelectorAll("button")].find(button => button.textContent === "Create mission")!;
      expect(submit.disabled).toBe(false);
      await act(async () => { submit.click(); });
      expect(missionsApi.create).toHaveBeenCalledWith("company", expect.objectContaining({
        sourceMissionId: "46d4f193-f32c-4adc-94ce-5514fb4a2a27", sourceWorkflowRunId: "963ff8de-1847-4968-8b72-a59d5987ef4e",
      }));
    } finally { await act(async () => root.unmount()); client.clear(); host.remove(); }
  });
});
