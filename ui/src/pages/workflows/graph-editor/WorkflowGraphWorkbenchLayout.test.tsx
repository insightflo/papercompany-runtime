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

function workbench(): HTMLElement {
  const shell = container.querySelector<HTMLElement>("[data-graph-workbench='true']")!;
  expect(shell, "graph workbench shell must exist").not.toBeNull();
  return shell;
}
function resizeHandle(shell: HTMLElement): HTMLElement {
  const handle = shell.querySelector<HTMLElement>("[data-graph-resize-handle='true']")!;
  expect(handle, "workbench must expose a vertical resize handle").not.toBeNull();
  return handle;
}

describe("Workflow graph resizable workbench", () => {
  it.each(["focus", "stacked"] as const)("reserves the canvas and resize-handle rows without the bottom details panel in the %s workspace", async (surface) => {
    await mountWorkspace(surface);
    const shell = workbench();
    const canvas = shell.querySelector<HTMLElement>("[data-graph-canvas-region]")!;
    const handle = resizeHandle(shell);
    // 상세 편집은 더블클릭 팝업으로 이동: 캔버스와 리사이즈 핸들만 남는다.
    expect(shell.children).toHaveLength(2);
    expect(shell.firstElementChild).toBe(canvas);
    expect(shell.lastElementChild).toBe(handle);
    expect(handle.getAttribute("role")).toBe("separator");
    expect(handle.getAttribute("aria-orientation")).toBe("horizontal");
    expect(shell.style.display).toBe("grid");
    expect(shell.style.height).toBe("calc(100dvh - 140px)");
    expect(shell.style.minHeight).toBe("480px");
    expect(shell.style.gridTemplateRows).toBe("minmax(0, 1fr) auto");
    expect(shell.style.alignContent).not.toBe("start");
    expect(shell.style.overflow).toBe("visible");
    expect(shell.querySelector("aside")).toBeNull();
    expect(container.querySelector("[data-graph-details-dialog]"), "details moved to the popup").toBeNull();
    expect(shell.textContent).not.toContain("Flow triggers");
    expect(container.textContent!.includes("Flow triggers")).toBe(surface === "stacked");
    expect(shell.parentElement).toBe(container.firstElementChild); // Real StepWorkspaceEditor wrapper.
    if (surface === "focus") expect(parseFloat(shell.parentElement!.style.minHeight)).toBe(0);
  });

  it("grows and shrinks the workbench by dragging the handle and restores the default height on double-click", async () => {
    await mountWorkspace("focus");
    const shell = workbench();
    const handle = resizeHandle(shell);
    const maxH = Math.max(480, window.innerHeight - 140);
    await act(async () => handle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, button: 0, clientY: 500 })));
    expect(document.body.style.cursor).toBe("ns-resize");
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { clientY: 700 })));
    // jsdom offsetHeight is 0 → the 480 fallback seeds the drag: 480 + 200, capped at the default height.
    expect(shell.style.height).toBe(`${Math.min(maxH, 680)}px`);
    expect(shell.style.minHeight).toBe(`${Math.min(maxH, 680)}px`); // Explicit size overrides the static 480px guard.
    await act(async () => window.dispatchEvent(new MouseEvent("mousemove", { clientY: 100 })));
    expect(shell.style.height).toBe("380px"); // Minimum clamp keeps the canvas usable.
    expect(shell.style.minHeight).toBe("380px");
    await act(async () => window.dispatchEvent(new MouseEvent("mouseup", { clientY: 100 })));
    expect(document.body.style.cursor).toBe("");
    expect(shell.style.height).toBe("380px");
    await act(async () => handle.dispatchEvent(new MouseEvent("dblclick", { bubbles: true })));
    expect(shell.style.height).toBe("calc(100dvh - 140px)");
    expect(shell.style.minHeight).toBe("480px");
  });

  it("resizes with ArrowUp/ArrowDown/Home keys on the handle", async () => {
    await mountWorkspace("focus");
    const shell = workbench();
    const handle = resizeHandle(shell);
    const maxH = Math.max(480, window.innerHeight - 140);
    const key = (k: string, shiftKey = false) => act(async () => handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true, shiftKey }),
    ));
    expect(handle.tabIndex).toBe(0);
    await key("ArrowUp");
    expect(shell.style.height).toBe(`${maxH - 40}px`);
    await key("ArrowUp");
    expect(shell.style.height).toBe(`${maxH - 80}px`);
    await key("ArrowDown");
    expect(shell.style.height).toBe(`${maxH - 40}px`);
    await key("Home");
    expect(shell.style.height).toBe("calc(100dvh - 140px)");
    for (let i = 0; i < 20; i += 1) await key("ArrowUp");
    expect(shell.style.height).toBe("380px"); // Keyboard resizing honors the same clamp.
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
