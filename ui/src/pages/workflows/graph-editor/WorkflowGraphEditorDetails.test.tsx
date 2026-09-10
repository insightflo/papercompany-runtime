// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyProvider } from "../../../context/CompanyContext.js";
import { jsonToSteps } from "../step-draft.js";
import { renderWorkflowGraphEditor } from "./WorkflowGraphEditor.js";
import { DefinitionsTable } from "../workflow-definitions-table.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;
let client: QueryClient;

async function mountEditor(definitions = false, graphPositionY = 0) {
  // Only external discovery/webhook status is stubbed; editor components and hooks are real.
  vi.stubGlobal("fetch", vi.fn(async (url: string) => new Response(JSON.stringify(
    String(url).endsWith("/webhook") ? { enabled: false, last4: null, deliveriesLast24h: 0 } : [],
  ), {
    headers: { "Content-Type": "application/json" },
  })));
  localStorage.clear();
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  function Editor() {
    const [steps, setSteps] = useState(() => jsonToSteps([
      { id: "collect", title: "자료 수집", type: "agent", graphPositionX: 0, graphPositionY: 0 },
      { id: "review", title: "기준 충족?", type: "if", dependsOn: ["collect"], graphPositionY },
    ]));
    if (definitions) return <DefinitionsTable
      workflows={[{ id: "daily", name: "일간 리포트", description: "", status: "active", steps: [
        { id: "collect", title: "자료 수집", type: "agent", dependsOn: [] },
      ] }]}
      companyId="company-b" refreshOverview={async () => {}} projects={[]} labels={[]}
      refreshLabels={async () => []} activeRuns={[]} recentRuns={[]} onManualRunStarted={() => {}}
      highlightedRunId={null} onAbortRun={() => {}} navigatorSearch="" availableTools={[]} availableToolGrants={[]}
    />;
    return renderWorkflowGraphEditor({
      steps, onChange: setSteps, availableTools: [], availableToolGrants: [], surface: "focus",
    });
  }
  await act(async () => root!.render(
    <QueryClientProvider client={client}><CompanyProvider><Editor /></CompanyProvider></QueryClientProvider>,
  ));
}

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
  client?.clear();
  vi.unstubAllGlobals();
});

function dialog(): HTMLElement {
  const el = container.querySelector<HTMLElement>("[data-graph-details-dialog='true']");
  expect(el, "double-click must open the details popup").not.toBeNull();
  return el!;
}
function nodeButtons(): NodeListOf<HTMLButtonElement> {
  return container.querySelectorAll<HTMLButtonElement>("button[data-graph-node='true']");
}
async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}
async function dblclick(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
}

describe("WorkflowGraphEditor details popup", () => {
  it("starts canvas-first with the definition rail collapsed and no popup open", async () => {
    await mountEditor(true);
    const expand = container.querySelector("button[aria-label='Expand sidebar']");
    expect(expand, "B layout reserves width for the graph by default").not.toBeNull();
    await click(expand!);
    expect(container.querySelector("button[aria-label='Collapse sidebar']")).not.toBeNull();
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Graph", "Form", "JSON", "Save", "Run"]));
    expect(container.textContent).toContain("웹훅");
    expect(container.querySelector("[data-graph-details-dialog]"), "details stay hidden until double-click").toBeNull();
    const shell = container.querySelector<HTMLElement>("[data-graph-workbench='true']")!;
    expect(shell.querySelector("aside"), "the bottom details panel is gone").toBeNull();
  });

  it("opens on node double-click with the selected step identity and inspector body", async () => {
    await mountEditor();
    const nodes = nodeButtons();
    await click(nodes[1]!);
    expect(container.querySelector("[data-graph-details-dialog]"), "single click only selects").toBeNull();
    await dblclick(nodes[1]!);
    const popup = dialog();
    expect(popup.getAttribute("role")).toBe("dialog");
    expect(popup.getAttribute("aria-modal")).toBe("true");
    expect(popup.textContent).toContain("기준 충족?");
    expect(popup.textContent).toContain("if");
    expect(popup.textContent).toContain("All conditions");
    expect(document.activeElement).toBe(popup);
  });

  it("opens for edge double-click with the relationship identity", async () => {
    await mountEditor();
    const edge = container.querySelector("[data-graph-edge='true']")!;
    await dblclick(edge);
    const popup = dialog();
    expect(popup.textContent).toContain("자료 수집 → 기준 충족?");
    expect(popup.textContent).toContain("연결");
  });

  it("closes via Escape, backdrop click, and the close button", async () => {
    await mountEditor();
    const nodes = nodeButtons();
    await dblclick(nodes[1]!);
    let popup = dialog();
    await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[data-graph-details-dialog]")).toBeNull();

    await dblclick(nodes[1]!);
    const backdrop = container.querySelector<HTMLElement>("[data-graph-details-backdrop='true']")!;
    expect(backdrop).not.toBeNull();
    await click(backdrop);
    expect(container.querySelector("[data-graph-details-dialog]")).toBeNull();

    await dblclick(nodes[1]!);
    await click(container.querySelector("button[aria-label='상세 편집 닫기']")!);
    expect(container.querySelector("[data-graph-details-dialog]")).toBeNull();
  });

  it("keeps self-connection errors visible next to the canvas while the popup is closed", async () => {
    await mountEditor();
    const output = container.querySelector("[data-graph-handle-kind='output'][data-step-id='collect']")!;
    const input = container.querySelector("[data-graph-handle-kind='input'][data-step-id='collect']")!;
    const startConnection = () => act(async () => {
      output.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await startConnection();
    await click(input);
    const error = [...container.querySelectorAll("p")].find((p) => p.textContent === "Cannot connect a step to itself.");
    expect(error, "the real connection handler must reject the self-edge").toBeDefined();
    expect(error!.closest("[data-graph-details-dialog]"), "closed-state errors render outside the popup").toBeNull();
    expect(error!.getAttribute("role")).toBe("alert");
    await startConnection();
    expect(container.textContent).not.toContain("Cannot connect a step to itself.");
  });

  it("places the full-width canvas above the resize handle without a horizontal rail", async () => {
    await mountEditor();
    const shell = container.querySelector<HTMLElement>("[data-graph-workbench='true']")!;
    const canvas = shell.querySelector<HTMLElement>("[data-graph-canvas-region]")!;
    const handle = shell.querySelector<HTMLElement>("[data-graph-resize-handle='true']")!;
    expect(shell.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(canvas.compareDocumentPosition(handle) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[aria-label='Resize graph inspector']")).toBeNull();
  });

  it("renders the details popup as a fixed overlay above the workspace", async () => {
    await mountEditor(true);
    await dblclick(nodeButtons()[0]!);
    const backdrop = container.querySelector<HTMLElement>("[data-graph-details-backdrop='true']")!;
    expect(backdrop.style.position).toBe("fixed");
    expect(parseFloat(backdrop.style.zIndex)).toBeGreaterThanOrEqual(40);
    const popup = dialog();
    // jsdom drops CSS min() values, so width is asserted via the style source instead.
    expect(popup.getAttribute("style") ?? "").not.toContain("position");
    expect(document.activeElement).toBe(popup);
  });

  it("opens with the keyboard (Enter) and restores focus to the node on close", async () => {
    await mountEditor();
    const node = nodeButtons()[1]!;
    node.focus();
    await act(async () => node.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
    const popup = dialog();
    expect(popup.textContent).toContain("기준 충족?");
    expect(document.body.style.overflow).toBe("hidden");
    await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    expect(container.querySelector("[data-graph-details-dialog]")).toBeNull();
    expect(document.activeElement).toBe(node);
    expect(document.body.style.overflow).not.toBe("hidden");
  });

  it("traps Tab focus inside the popup", async () => {
    await mountEditor();
    await dblclick(nodeButtons()[1]!);
    const popup = dialog();
    const focusables = [...popup.querySelectorAll<HTMLElement>("button, [href], input, select, textarea")];
    expect(focusables.length).toBeGreaterThan(1);
    const last = focusables[focusables.length - 1]!;
    const first = focusables[0]!;
    last.focus();
    await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(first);
    await act(async () => popup.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true })));
    expect(document.activeElement).toBe(last);
  });

  it.each([[0, "360px"], [1000, "1132px"]] as const)("fills the SVG and retains graph bounds at node y=%i", async (y, minHeight) => {
    await mountEditor(false, y);
    const svg = container.querySelector<SVGSVGElement>("svg[width][height]")!;
    const content = svg.parentElement!;
    const viewport = content.parentElement!.parentElement!;
    expect(svg.getAttribute("height")).toBe("100%");
    expect(svg.getAttribute("width")).toBe("100%");
    expect(content.style.height).toBe("100%");
    expect(content.style.width).toBe("100%");
    expect(content.style.minHeight).toBe(minHeight);
    expect(parseFloat(content.style.minWidth)).toBeGreaterThanOrEqual(620);
    expect(viewport.style.overflow).toBe("auto");
    expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
  });

  it("keeps edit/view docks outside the drawing scrollport during local scrolling", async () => {
    await mountEditor(false, 1000);
    const svg = container.querySelector<SVGSVGElement>("svg[width][height]")!;
    const viewport = svg.parentElement!.parentElement!.parentElement!;
    const frame = viewport.parentElement!;
    const docks = [...container.querySelectorAll<HTMLElement>("[data-graph-toolbar='true']")];
    expect(docks).toHaveLength(2);
    expect(frame.style.position).toBe("relative");
    for (const dock of docks) {
      expect(viewport.contains(dock), "scrolling the drawing must not scroll the tool docks").toBe(false);
      expect(dock.parentElement!.parentElement).toBe(frame);
      expect(dock.parentElement!.style.position).toBe("absolute");
    }
    viewport.scrollLeft = 100;
    viewport.scrollTop = 600;
    await act(async () => viewport.dispatchEvent(new Event("scroll")));
    await click(container.querySelector("button[aria-label='Zoom in']")!);
    expect(svg.parentElement!.style.transform).toBe("translate(0px, 0px) scale(1.1)");
    expect(viewport.scrollTop).toBe(600);
    await click(container.querySelector("[data-graph-edge='true']")!);
    await act(async () => container.querySelector("button[aria-label='Delete selected relationship']")!
      .dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 })));
    expect(container.querySelector("[data-graph-edge='true']")).toBeNull();
  });

  it("keeps wheel zoom anchored to the pointer after local canvas scrolling", async () => {
    await mountEditor(false, 1000);
    const svg = container.querySelector<SVGSVGElement>("svg[width][height]")!;
    const content = svg.parentElement!;
    const viewport = content.parentElement!.parentElement!;
    viewport.scrollLeft = 100;
    viewport.scrollTop = 80;
    await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", {
      bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 160,
    })));
    const values = content.style.transform.match(/-?[\d.]+/g)!.map(Number);
    expect(values[0]).toBeCloseTo(-30);
    expect(values[1]).toBeCloseTo(-24);
    expect(values[2]).toBe(1.1);
  });

  it("centers the selected node inside the scrolled canvas viewport", async () => {
    await mountEditor(false, 1000);
    const svg = container.querySelector<SVGSVGElement>("svg[width][height]")!;
    const content = svg.parentElement!;
    const viewport = content.parentElement!.parentElement!;
    Object.defineProperties(viewport, { clientWidth: { value: 800 }, clientHeight: { value: 500 } });
    viewport.scrollLeft = 100;
    viewport.scrollTop = 80;
    await click(container.querySelector("button[aria-label='Center selected']")!);
    expect(content.style.transform).toBe("translate(414px, 292px) scale(1)");
  });
});
