// @vitest-environment jsdom
// ShortsResumeSketch: 격리 local-sketch 컴포넌트 동작 테스트 (production 마운트 아님).
// 선택 step/confirm 이 정확한 ID 를 전달하는지와 사람 승인 컨트롤 부재를 증명한다.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  ShortsResumeSketch,
  type ShortsResumeSketchDeliveryView,
  type ShortsResumeSketchPreviewView,
} from "./ShortsResumeSketch";

const preview: ShortsResumeSketchPreviewView = {
  schema: "shorts.local-sketch-preview.v1",
  mode: "local-sketch",
  previewId: "local-sketch-preview:44444444-4444-4444-8444-444444444444:clips-gate",
  startStepId: "clips-gate",
  workflowRunId: "44444444-4444-4444-8444-444444444444",
  affectedStepIds: [
    "assemble",
    "assemble-blocked",
    "assemble-gate",
    "clips-blocked",
    "clips-gate",
    "final-review",
    "publish",
  ],
  blockedSteps: [],
  preservedProducerStepId: "flow-clips",
  outsideStepIds: ["archive-log"],
};

const OPTIONS = ["clips-gate", "assemble-gate", "publish"];

let host: HTMLDivElement;
let root: Root;

async function render(node: React.ReactNode) {
  await act(async () => {
    root.render(node);
  });
}

function click(element: Element) {
  act(() => (element as HTMLElement).click());
}

function renderSketch(props: Partial<Parameters<typeof ShortsResumeSketch>[0]> = {}) {
  return render(
    <ShortsResumeSketch
      preview={props.preview ?? preview}
      delivery={props.delivery ?? null}
      startStepOptions={props.startStepOptions ?? OPTIONS}
      onPreview={props.onPreview ?? vi.fn()}
      onApply={props.onApply ?? vi.fn()}
      disabled={props.disabled}
      busy={props.busy}
      error={props.error}
    />,
  );
}

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
});

describe("ShortsResumeSketch", () => {
  it("renders the local mock banner, structured view, and no approval control", async () => {
    await renderSketch();
    expect(host.querySelector("[data-banner='local-sketch']")).not.toBeNull();
    expect(host.querySelector("[data-testid='shorts-sketch-producer']")?.textContent).toContain("flow-clips");
    expect([...host.querySelectorAll("li")].map((li) => li.textContent)).toEqual(preview.affectedStepIds);
    expect(host.querySelector("select")?.value).toBe("clips-gate");
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels.join("|")).not.toMatch(/approve/i);
  });

  it("forwards the exact preview id on confirm", async () => {
    const onApply = vi.fn();
    await renderSketch({ onApply });
    click(host.querySelector("[data-testid='shorts-sketch-apply']")!);
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply).toHaveBeenCalledWith(preview.previewId);
  });

  it("forwards the exact selected start step on change", async () => {
    const onPreview = vi.fn();
    await renderSketch({ onPreview });
    const select = host.querySelector("select")!;
    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!;
      setValue.call(select, "assemble-gate");
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(onPreview).toHaveBeenCalledTimes(1);
    expect(onPreview).toHaveBeenCalledWith("assemble-gate");
  });

  it("disables confirm while disabled or busy and renders the error text", async () => {
    const onApply = vi.fn();
    await renderSketch({ onApply, disabled: true, busy: true, error: "apply rejected" });
    const button = host.querySelector("[data-testid='shorts-sketch-apply']") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    click(button);
    expect(onApply).not.toHaveBeenCalled();
    expect(host.querySelector("[data-testid='shorts-sketch-error']")?.textContent).toContain("apply rejected");
  });

  it("shows waiting human review without any approval control", async () => {
    const delivery: ShortsResumeSketchDeliveryView = {
      schema: "shorts.local-sketch-delivery.v1",
      mode: "local-sketch",
      requestId: "req-1",
      stage: "final-review",
      waitingHumanReview: true,
      waitingReconciliation: false,
      blocked: null,
      uploadResult: null,
    };
    await renderSketch({ delivery });
    expect(host.querySelector("[data-testid='shorts-sketch-waiting-review']")?.textContent)
      .toContain("human review");
    const labels = [...host.querySelectorAll("button")].map((button) => button.textContent ?? "");
    expect(labels.join("|")).not.toMatch(/approve/i);
  });

  it("shows the upload result and the blocked branch records", async () => {
    const published: ShortsResumeSketchDeliveryView = {
      schema: "shorts.local-sketch-delivery.v1",
      mode: "local-sketch",
      requestId: "req-1",
      stage: "published",
      waitingHumanReview: false,
      waitingReconciliation: false,
      blocked: null,
      uploadResult: { videoId: "local-sketch-video-1", channelId: "local-sketch-channel" },
    };
    await renderSketch({ delivery: published });
    expect(host.querySelector("[data-testid='shorts-sketch-upload']")?.textContent)
      .toContain("local-sketch-channel");

    const blocked: ShortsResumeSketchDeliveryView = {
      ...published,
      stage: "blocked",
      uploadResult: null,
      blocked: { stage: "clips-gate", branchStepId: "clips-blocked" },
    };
    await renderSketch({ delivery: blocked });
    expect(host.querySelector("[data-testid='shorts-sketch-blocked']")?.textContent)
      .toContain("clips-blocked");
  });
});
