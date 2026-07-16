import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GraphInspectorPolicyQaCapAcceptance } from "./GraphInspectorPolicyQaCapAcceptance.js";
import type { QaCapAcceptancePolicy } from "../qa-cap-acceptance-policy.js";

const noop = () => {};

function render(policy: QaCapAcceptancePolicy): string {
  return renderToStaticMarkup(
    <GraphInspectorPolicyQaCapAcceptance
      policy={policy}
      onLoopEnabledChange={vi.fn()}
      onMaxIterationsChange={vi.fn()}
      onAllowCapAcceptanceChange={vi.fn()}
    />,
  );
}

describe("GraphInspectorPolicyQaCapAcceptance", () => {
  it("always shows the QA review-step toggle, even when ambiguous", () => {
    const html = render({ available: false, reason: "Multiple bounded QA rework edges target this step." });
    expect(html).toContain("Enable QA rework loop");
    expect(html).toContain("more than one producer rework edge");
    expect(html).toContain("disabled"); // toggle locked while ambiguous
  });

  it("always shows the toggle when no upstream producer exists", () => {
    const html = render({
      available: true,
      enabled: false,
      producerStepId: null,
      producerCandidates: [],
      requiresProducerSelection: false,
    });
    expect(html).toContain("Enable QA rework loop");
    expect(html).toContain("Add an upstream dependency");
  });

  it("shows an enabled loop with rework attempts, producer, and cap acceptance together", () => {
    const html = render({
      available: true,
      enabled: true,
      allowCapAcceptance: true,
      maxIterations: 3,
      producerStepId: "producer",
    });
    expect(html).toContain("Enable QA rework loop");
    expect(html).toContain("checked"); // loop toggle on
    expect(html).toContain("QA rework attempts");
    expect(html).toContain('value="3"');
    expect(html).toContain("Continue with recorded limitations");
    expect(html).toContain("producer");
  });

  it("auto-selects and names the single upstream producer without a dropdown", () => {
    const html = render({
      available: true,
      enabled: false,
      producerStepId: "producer",
      producerCandidates: ["producer"],
      requiresProducerSelection: false,
    });
    expect(html).toContain("Reworks producer:");
    expect(html).toContain("producer");
    expect(html).not.toContain("Producer to rework");
  });

  it("offers an explicit producer dropdown when multiple upstreams exist", () => {
    const html = render({
      available: true,
      enabled: false,
      producerStepId: null,
      producerCandidates: ["producer", "research"],
      requiresProducerSelection: true,
    });
    expect(html).toContain("Producer to rework");
    // No producer is pre-selected: a disabled placeholder is shown and the loop
    // toggle stays locked until the user explicitly chooses a producer.
    expect(html).toContain("Select a producer");
    expect(html).toContain('type="checkbox" disabled');
    expect(html).toContain('value="producer"');
    expect(html).toContain('value="research"');
  });

  it("keeps the QA rework section distinct from generic max retries", () => {
    const html = render({
      available: true,
      enabled: true,
      allowCapAcceptance: false,
      maxIterations: 2,
      producerStepId: "producer",
    });
    expect(html).toContain("separate from the generic");
  });
});

describe("GraphInspectorPolicyQaCapAcceptance handler wiring", () => {
  it("renders a creatable single-producer toggle without firing handlers", () => {
    const onLoopEnabledChange = vi.fn();
    const handlers = { onLoopEnabledChange, onMaxIterationsChange: noop, onAllowCapAcceptanceChange: noop };
    // SSR cannot fire events; verify the toggle is rendered unchecked for a creatable single-producer step.
    const html = renderToStaticMarkup(
      <GraphInspectorPolicyQaCapAcceptance
        policy={{
          available: true,
          enabled: false,
          producerStepId: "producer",
          producerCandidates: ["producer"],
          requiresProducerSelection: false,
        }}
        {...handlers}
      />,
    );
    expect(html).not.toContain("checked");
    expect(onLoopEnabledChange).not.toHaveBeenCalled();
  });
});
