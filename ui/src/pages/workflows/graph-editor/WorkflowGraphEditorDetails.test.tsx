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

function disclosure() {
  const button = container.querySelector<HTMLButtonElement>("button[aria-controls][aria-expanded]");
  expect(button, "selected details must have a persistent disclosure button").not.toBeNull();
  return button!;
}
function bodyFor(button: HTMLButtonElement) {
  const body = document.getElementById(button.getAttribute("aria-controls")!);
  expect(body).not.toBeNull();
  return body!;
}
async function click(element: Element) {
  await act(async () => element.dispatchEvent(new MouseEvent("click", { bubbles: true })));
}

describe("WorkflowGraphEditor bottom details", () => {
  it("starts canvas-first with the definition rail collapsed but still available", async () => {
    await mountEditor(true);
    const expand = container.querySelector("button[aria-label='Expand sidebar']");
    expect(expand, "B layout reserves width for the graph by default").not.toBeNull();
    await click(expand!);
    expect(container.querySelector("button[aria-label='Collapse sidebar']")).not.toBeNull();
    const buttons = [...container.querySelectorAll("button")].map((button) => button.textContent);
    expect(buttons).toEqual(expect.arrayContaining(["Graph", "Form", "JSON", "Save", "Run"]));
    expect(container.textContent).toContain("웹훅");
    expect(disclosure().getAttribute("aria-expanded")).toBe("true");
  });

  it("keeps the same fixed-width native button and selected identity while hiding only the body", async () => {
    await mountEditor();
    const button = disclosure();
    const body = bodyFor(button);
    const header = button.parentElement!;
    const panel = header.closest("aside")!;
    // Structural dock invariant: changing body height cannot add space below the header.
    expect(panel.lastElementChild).toBe(header);
    expect(body.compareDocumentPosition(header) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const headerStyle = header.getAttribute("style");
    const buttonStyle = button.getAttribute("style");
    const field = body.querySelector("input");
    expect(button.type).toBe("button"); // Native Enter/Space activation, no custom keyboard shim.
    expect(button.style.width).toBe("160px");
    expect(button.style.flexShrink).toBe("0");
    expect(button.getAttribute("aria-expanded")).toBe("true");
    expect(header.textContent).toContain("자료 수집");
    expect(header.textContent).toContain("agent");
    button.focus();
    await click(button);
    expect(disclosure()).toBe(button);
    expect(button.parentElement).toBe(header);
    expect(header.getAttribute("style")).toBe(headerStyle);
    expect(button.getAttribute("style")).toBe(buttonStyle);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    expect(button.textContent).toContain("펼치기");
    expect(body.hidden).toBe(true);
    expect(panel.lastElementChild).toBe(header);
    expect(header.closest("[hidden]")).toBeNull();
    expect(header.textContent).toContain("자료 수집");
    expect(header.textContent).toContain("agent");
    expect(document.activeElement).toBe(button);
    expect(body.querySelector("input")).toBe(field);
    await click(button);
    expect(disclosure()).toBe(button);
    expect(body.hidden).toBe(false);
    expect(panel.lastElementChild).toBe(header);
    expect(button.textContent).toContain("접기");
  });

  it("opens for node/edge selection, including reselecting the current target", async () => {
    await mountEditor();
    const button = disclosure();
    const nodes = container.querySelectorAll("button[data-graph-node='true']");
    const edge = container.querySelector("[data-graph-edge='true']")!;
    for (const target of [nodes[1]!, nodes[1]!, edge, edge]) {
      await click(button);
      expect(bodyFor(button).hidden).toBe(true);
      await click(target);
      expect(disclosure()).toBe(button);
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(bodyFor(button).hidden).toBe(false);
      if (target !== edge) {
        expect(button.parentElement!.textContent).toContain("기준 충족?");
        expect(button.parentElement!.textContent).toContain("if");
        expect(bodyFor(button).textContent).toContain("All conditions");
      }
    }
    expect(button.parentElement!.textContent).toContain("자료 수집 → 기준 충족?");
    expect(button.parentElement!.textContent).toContain("연결");
  });

  it("shows self-connection errors while details stay manually collapsed", async () => {
    await mountEditor();
    const button = disclosure();
    const header = button.parentElement!;
    const buttonStyle = button.getAttribute("style");
    const headerStyle = header.getAttribute("style");
    const output = container.querySelector("[data-graph-handle-kind='output'][data-step-id='collect']")!;
    const input = container.querySelector("[data-graph-handle-kind='input'][data-step-id='collect']")!;
    const startConnection = () => act(async () => {
      output.dispatchEvent(new MouseEvent("pointerdown", { bubbles: true, button: 0 }));
    });
    await click(button);
    await startConnection();
    await click(input);
    const error = [...container.querySelectorAll("p")].find((p) => p.textContent === "Cannot connect a step to itself.");
    expect(error, "the real connection handler must reject the self-edge").toBeDefined();
    expect(error!.closest("[hidden]"), "canvas errors must not be inside the collapsed body").toBeNull();
    expect(bodyFor(button).hidden).toBe(true);
    expect(button.getAttribute("aria-expanded")).toBe("false");
    for (const expanded of [true, false]) {
      await click(button);
      expect(disclosure()).toBe(button);
      expect(button.parentElement).toBe(header);
      expect(button.getAttribute("style")).toBe(buttonStyle);
      expect(header.getAttribute("style")).toBe(headerStyle);
      expect(bodyFor(button).hidden).toBe(!expanded);
      expect(error!.closest("[hidden]")).toBeNull();
      expect(header.closest("aside")!.lastElementChild).toBe(header);
    }
    await startConnection();
    expect(container.textContent).not.toContain("Cannot connect a step to itself.");
    expect(bodyFor(button).hidden).toBe(true);
  });

  it("places the full-width canvas before the details without a horizontal resize rail", async () => {
    await mountEditor();
    const button = disclosure();
    const panel = button.closest("aside")!;
    const shell = panel.parentElement!;
    const canvas = shell.querySelector<HTMLElement>("[data-graph-canvas-region]")!;
    expect(canvas).not.toBeNull();
    expect(shell.style.gridTemplateColumns).toBe("minmax(0, 1fr)");
    expect(canvas.compareDocumentPosition(panel) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector("[aria-label='Resize graph inspector']")).toBeNull();
    await click(button);
    expect(shell.lastElementChild).toBe(panel);
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

  it("keeps normal-flow details and visible graph ancestors", async () => {
    await mountEditor(true);
    const button = disclosure();
    const panel = button.closest("aside")!;
    const body = bodyFor(button);
    expect(panel.style.position).toBe("");
    expect(panel.style.bottom).toBe("");
    expect(panel.style.zIndex).toBe("");
    expect(panel.style.background).toBe("var(--background, #020617)");
    expect(body.style.maxHeight).toBe("45vh");
    expect(body.style.overflowY).toBe("auto");
    expect(container.querySelector<HTMLElement>("#wf-editor")!.style.overflow).toBe("visible");
    expect(panel.parentElement!.style.overflow).toBe("visible");
    for (let ancestor = panel.parentElement; ancestor && ancestor !== container; ancestor = ancestor.parentElement) {
      expect(["hidden", "auto", "scroll", "clip"], ancestor.outerHTML.slice(0, 220)).not.toContain(ancestor.style.overflow);
    }
    const panelStyle = panel.getAttribute("style");
    await click(button);
    expect(disclosure().closest("aside")).toBe(panel);
    expect(panel.getAttribute("style")).toBe(panelStyle);
    expect(body.hidden).toBe(true);
    expect(panel.children.length).toBe(2); // Header only when the retained body is hidden.
  });
});
