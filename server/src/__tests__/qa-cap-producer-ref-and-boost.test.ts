import { describe, expect, it } from "vitest";
import {
  buildQaReworkCapDescription,
  extractQaCapProducerIssueRef,
  extractQaCapQaStepId,
  isQaReworkCapOversightIssue,
} from "../services/missions/qa-rework-cap-oversight.js";
import { QA_REWORK_CAP_BOOST_KEY, readCapBoostAmount } from "../services/workflow/control-flow/types.js";

const exhaustion = {
  workflowRunId: "run-1",
  producerStepId: "materialize-html-report",
  producerIssueId: "52b222fc-7cc7-4ebd-a651-a836ab7d0789",
  producerIteration: 2,
  producerCompletedAt: "2026-08-14T00:41:42.453Z",
  qaStepId: "qa-dashboard-html",
  qaStepRunId: "qa-step-run-1",
  maxIterations: 2,
};

describe("qa-cap description producer/QA ref extraction", () => {
  it("extracts producer issue ref and QA step id from the generated description", () => {
    const description = buildQaReworkCapDescription({
      keyMarker: "qa-cap-key:54c0b3189c55b688d3ff021cf350acbf",
      exhaustion,
      missionTitle: "mission",
      workflowName: "gazua-morning",
    });
    expect(isQaReworkCapOversightIssue(description)).toBe(true);
    expect(extractQaCapProducerIssueRef(description)).toBe(exhaustion.producerIssueId);
    expect(extractQaCapQaStepId(description)).toBe(exhaustion.qaStepId);
  });

  it("returns null for non-cap descriptions", () => {
    expect(extractQaCapProducerIssueRef("plain text")).toBeNull();
    expect(extractQaCapQaStepId("plain text")).toBeNull();
    expect(isQaReworkCapOversightIssue(null)).toBe(false);
  });
});

describe("qa rework cap boost metadata", () => {
  it("reads a valid boost amount from step run metadata", () => {
    const metadata = { [QA_REWORK_CAP_BOOST_KEY]: { amount: 3, reason: "manual retry" } };
    expect(readCapBoostAmount(metadata)).toBe(3);
  });

  it("converges to 0 for invalid boost shapes", () => {
    expect(readCapBoostAmount(null)).toBe(0);
    expect(readCapBoostAmount({})).toBe(0);
    expect(readCapBoostAmount({ [QA_REWORK_CAP_BOOST_KEY]: { amount: -1 } })).toBe(0);
    expect(readCapBoostAmount({ [QA_REWORK_CAP_BOOST_KEY]: { amount: 2.5 } })).toBe(0);
    expect(readCapBoostAmount("boost")).toBe(0);
  });
});
