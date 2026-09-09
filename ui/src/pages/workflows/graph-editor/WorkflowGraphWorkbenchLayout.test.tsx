// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyProvider } from "../../../context/CompanyContext.js";
import { jsonToSteps } from "../step-draft.js";
import { StepWorkspaceEditor, type StepWorkspaceSurface } from "../step-workspace-editor.js";
import { renderWorkflowGraphEditor } from "./WorkflowGraphEditor.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

async function mountWorkspace(surface: StepWorkspaceSurface) {
  // Stub external discovery only; render the real workspace, graph and details.
  vi.stubGlobal("fetch", vi.fn(async () => new Response("[]", {
    headers: { "Content-Type": "application/json" },
  })));
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Workspace() {
    const [steps, setSteps] = useState(() => jsonToSteps([
      { id: "collect", title: "자료 수집", type: "agent", graphPositionY: 1000 },
    ]));
    return <StepWorkspaceEditor steps={steps} onChange={setSteps} surface={surface}
      mode="graph" onModeChange={() => {}} jsonText="" onJsonTextChange={() => {}} onJsonError={() => {}}
      availableTools={[]} availableToolGrants={[]} renderGraphEditor={renderWorkflowGraphEditor} />;
  }
  await act(async () => root!.render(
    <QueryClientProvider client={client}><CompanyProvider><Workspace /></CompanyProvider></QueryClientProvider>,
  ));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  vi.unstubAllGlobals();
});

describe("Workflow graph fixed-height workbench", () => {
  it.each(["focus", "stacked"] as const)("reserves only canvas and details rows in the %s workspace", async (surface) => {
    await mountWorkspace(surface);
    const panel = container.querySelector("aside")!;
    const workbench = panel.parentElement!;
    const canvas = workbench.querySelector<HTMLElement>("[data-graph-canvas-region]")!;
    // A trigger card inside this grid would displace details into an implicit third row.
    expect(workbench.children).toHaveLength(2);
    expect(workbench.firstElementChild).toBe(canvas);
    expect(workbench.lastElementChild).toBe(panel);
    expect(workbench.style.display).toBe("grid");
    expect(workbench.style.height).toBe("calc(100dvh - 140px)");
    expect(workbench.style.minHeight).toBe("480px");
    expect(workbench.style.gridTemplateRows).toBe("minmax(0, 1fr) auto");
    expect(workbench.style.alignContent).not.toBe("start");
    expect(workbench.style.overflow).toBe("visible");
    expect(workbench.textContent).not.toContain("Flow triggers");
    expect(container.textContent!.includes("Flow triggers")).toBe(surface === "stacked");
    expect(workbench.parentElement).toBe(container.firstElementChild); // Real StepWorkspaceEditor wrapper.
    if (surface === "focus") expect(parseFloat(workbench.parentElement!.style.minHeight)).toBe(0);
    const button = panel.querySelector<HTMLButtonElement>("button[aria-controls]")!;
    const body = document.getElementById(button.getAttribute("aria-controls")!)!;
    const height = workbench.style.height;
    for (const expanded of [false, true]) {
      await act(async () => button.dispatchEvent(new MouseEvent("click", { bubbles: true })));
      expect(body.hidden).toBe(!expanded);
      expect(workbench.style.height).toBe(height);
      expect(workbench.lastElementChild).toBe(panel);
      expect(panel.lastElementChild).toBe(button.parentElement);
    }
  });

  it("lets the drawing shrink into the remaining row while its graph bounds stay scrollable", async () => {
    await mountWorkspace("focus");
    const canvas = container.querySelector<HTMLElement>("[data-graph-canvas-region]")!;
    const main = canvas.firstElementChild as HTMLElement;
    const frame = main.firstElementChild as HTMLElement;
    const viewport = frame.firstElementChild as HTMLElement;
    for (const element of [canvas, main, frame, viewport]) {
      expect(parseFloat(element.style.minHeight), "every intermediary must allow the canvas row to shrink").toBe(0);
    }
    expect(canvas.style.display).toBe("grid");
    expect(main.style.gridTemplateRows).toBe("minmax(0, 1fr) auto");
    expect(main.children).toHaveLength(2); // Drawing/tools frame then status strip.
    expect(frame.style.position).toBe("relative");
    expect(viewport.style.height).toBe("100%");
    expect(viewport.style.maxHeight).toBe("");
    expect(viewport.style.overflow).toBe("auto");
    const svg = viewport.querySelector<SVGSVGElement>("svg[width][height]")!;
    expect(svg.getAttribute("height")).toBe("100%");
    expect(parseFloat(svg.parentElement!.style.minHeight)).toBeGreaterThan(1000);
  });
});
