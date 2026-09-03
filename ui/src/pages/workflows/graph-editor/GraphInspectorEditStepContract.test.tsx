// @vitest-environment node
// [B안 스텝 계약] 그래프 인스펙터 EDIT 블록의 Step contract 섹션 렌더 검증.
// agent 스텝에만 3개 계약 입력(사전/사후/미정의)이 노출되고, if 제어노드에는 노출되지 않는다.
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { GraphInspectorEditStep } from "./GraphInspectorEditStep.js";
import { jsonToSteps } from "../step-draft-serialization.js";

const noop = () => {};
const pointerNoop = (_event: unknown) => {};

function renderInspector(stepOverrides: Record<string, unknown>): string {
  const drafts = jsonToSteps([{ id: "s1", title: "Step 1", type: "agent", ...stepOverrides } as never]);
  const selectedStep = drafts[0]!;
  return renderToStaticMarkup(
    <GraphInspectorEditStep
      showEditInspector={true}
      steps={drafts}
      selectedStep={selectedStep}
      availableTools={[]}
      availableToolGrants={[]}
      graphAgents={[]}
      renameSelectedStep={noop}
      updateSelected={vi.fn()}
      updateSelectedDataFlow={vi.fn()}
      updateSelectedResources={vi.fn()}
      addAfter={noop}
      duplicateSelectedStep={noop}
      handleDeleteGraphObjectPointerDown={pointerNoop}
    />,
  );
}

describe("GraphInspectorEditStep step contract section", () => {
  it("shows the three contract inputs for agent steps with hydrated values", () => {
    const html = renderInspector({
      contract: {
        preconditions: ["Data source brief is registered"],
        postconditions: ["Report registers a workProduct"],
        undefinedBehaviors: ["If the source is unreachable the content is undefined"],
      },
    });
    expect(html).toContain("Step contract");
    expect(html).toContain("Preconditions");
    expect(html).toContain("Postconditions");
    expect(html).toContain("Undefined behaviors");
    expect(html).toContain("Data source brief is registered");
    expect(html).toContain("Report registers a workProduct");
    expect(html).toContain("If the source is unreachable the content is undefined");
  });

  it("does not show the contract section for if control-node steps", () => {
    const html = renderInspector({
      type: "if",
      conditionGroup: {
        combinator: "all",
        conditions: [
          {
            source: { kind: "work_product_json", stepId: "producer", title: "decision.json", path: "$.status" },
            dataType: "string",
            operator: "equals",
            rightValue: "selected",
          },
        ],
      },
    });
    expect(html).not.toContain("Step contract");
  });
});
