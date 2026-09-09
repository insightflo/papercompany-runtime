// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it } from "vitest";
import { WorkflowRunGraphPreview } from "./GraphRunPreview.js";

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
let container: HTMLDivElement;

afterEach(async () => {
  await act(async () => root?.unmount());
  root = undefined;
  container?.remove();
});

it("does not inherit editor-only native scrolling or viewport height bounds in run preview", async () => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<WorkflowRunGraphPreview steps={[
    { id: "collect", title: "Collect", type: "agent", graphPositionX: 0, graphPositionY: 0 },
  ]} />));
  const tools = container.querySelector<HTMLElement>("[data-graph-toolbar='true']")!;
  const viewport = tools.parentElement!.parentElement!;
  // This consumer has no native-scroll coordinate/reset support: preserve its original viewport.
  expect(viewport.style.overflow).toBe("hidden");
  expect(viewport.style.height).toBe("100%");
  expect(viewport.style.minHeight).toBe("260px");
  expect(viewport.style.maxHeight).toBe("");
  const content = [...viewport.querySelectorAll<HTMLElement>("div")].find((div) => div.style.transform)!;
  await act(async () => viewport.dispatchEvent(new WheelEvent("wheel", {
    bubbles: true, cancelable: true, deltaY: -100, clientX: 200, clientY: 160,
  })));
  const values = content.style.transform.match(/-?[\d.]+/g)!.map(Number);
  expect(values[0]).toBeCloseTo(-20);
  expect(values[1]).toBeCloseTo(-16);
  expect(values[2]).toBe(1.1);
  await act(async () => container.querySelector("button[aria-label='Reset zoom']")!
    .dispatchEvent(new MouseEvent("click", { bubbles: true })));
  expect(content.style.transform).toBe("translate(0px, 0px) scale(1)");
});
