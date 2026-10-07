// @vitest-environment jsdom
import { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CompanyProvider } from "../../../context/CompanyContext.js";
import { jsonToSteps } from "../step-draft.js";
import { StepWorkspaceEditor } from "../step-workspace-editor.js";
import { renderWorkflowGraphEditor } from "./WorkflowGraphEditor.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
async function mount() {
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
      { id: "source", title: "Source", type: "agent" },
      { id: "target", title: "Target", type: "agent" },
    ]));
    return <StepWorkspaceEditor steps={steps} onChange={setSteps} surface="focus"
      mode="graph" onModeChange={() => {}} jsonText="" onJsonTextChange={() => {}} onJsonError={() => {}}
      availableTools={[]} availableToolGrants={[]} renderGraphEditor={renderWorkflowGraphEditor} />;
  }
  await act(async () => root.render(
    <QueryClientProvider client={client}><CompanyProvider><Workspace /></CompanyProvider></QueryClientProvider>,
  ));
}
afterEach(async () => {
  await act(async () => root?.unmount());
  container?.remove();
  client?.clear();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const port = (id: string, kind: string) => container.querySelector<HTMLElement>(
  `[data-step-id="${id}"][data-graph-handle-kind="${kind}"]`,
)!;
const query = (name: string) => container.querySelector(`[data-graph-${name}]`);
async function pointer(target: EventTarget, type: string, x = 0, y = 0) {
  await act(async () => target.dispatchEvent(new MouseEvent(type, {
    bubbles: true, button: 0, clientX: x, clientY: y,
  })));
}

describe("connection decorations in the real graph editor", () => {
  it("follows the pointer while connecting, then removes the preview and briefly ripples on a new edge", async () => {
    await mount();
    expect(query("connection-preview")).toBeNull();
    await pointer(port("source", "output"), "pointerdown");
    expect(query("connection-preview")).not.toBeNull();
    const initial = query("connection-preview")!.getAttribute("d");
    await pointer(window, "pointermove", 420, 260);
    expect(query("connection-preview")!.getAttribute("d")).not.toBe(initial);
    expect(query("connection-preview")!.getAttribute("stroke")).toBe("#fff");
    vi.useFakeTimers();
    await pointer(port("target", "input"), "pointerup");
    expect(query("connection-preview")).toBeNull();
    expect(container.querySelectorAll('[data-graph-edge="true"]')).toHaveLength(1);
    expect(query("connection-ripple")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(600));
    expect(query("connection-ripple")).toBeNull();
  });

  it("uses the rendered viewport matrix for both the source port and pointer", async () => {
    await mount();
    const svg = query("connection-effects") as SVGSVGElement;
    Object.defineProperty(svg, "getScreenCTM", { value: () => ({ a: 2, d: 2, e: 100, f: 40 }) });
    vi.spyOn(port("source", "output"), "getBoundingClientRect").mockReturnValue(
      { x: 194, y: 194, left: 194, top: 194, width: 12, height: 12, right: 206, bottom: 206, toJSON() {} },
    );
    await pointer(port("source", "output"), "pointerdown");
    await pointer(window, "pointermove", 500, 320);
    const path = query("connection-preview")!.getAttribute("d")!;
    expect(path).toBe("M 50 80 C 125 80, 125 140, 200 140");
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.style.pointerEvents).toBe("none");
  });

  it("does not celebrate an unchanged duplicate connection", async () => {
    await mount();
    vi.useFakeTimers();
    await pointer(port("source", "output"), "pointerdown");
    await pointer(port("target", "input"), "pointerup");
    expect(query("connection-ripple")).not.toBeNull();
    await act(async () => vi.advanceTimersByTime(600));
    await pointer(port("source", "output"), "pointerdown");
    await pointer(port("target", "input"), "pointerup");
    expect(query("connection-ripple")).toBeNull();
    expect(container.querySelectorAll('[data-graph-edge="true"]')).toHaveLength(1);
  });

  it("shows a spark and ring only near another input; cancelling does not ripple", async () => {
    await mount();
    vi.spyOn(port("target", "input"), "getBoundingClientRect").mockReturnValue(
      { x: 294, y: 194, left: 294, top: 194, width: 12, height: 12, right: 306, bottom: 206, toJSON() {} },
    );
    await pointer(port("source", "output"), "pointerdown");
    await pointer(window, "pointermove", 290, 200);
    expect(query("connection-spark")).not.toBeNull();
    expect(query("connection-halo")).not.toBeNull();
    await pointer(window, "pointermove", 450, 320);
    expect(query("connection-spark")).toBeNull();
    expect(query("connection-halo")).toBeNull();
    await pointer(port("source", "input"), "pointerup");
    expect(query("connection-preview")).toBeNull();
    expect(query("connection-ripple")).toBeNull();
    expect(container.querySelectorAll('[data-graph-edge="true"]')).toHaveLength(0);
  });
});
