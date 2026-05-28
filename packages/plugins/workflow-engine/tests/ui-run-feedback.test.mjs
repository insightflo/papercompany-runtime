import assert from "node:assert/strict";
import test from "node:test";

import {
  buildManualRunFeedback,
  buildManualRunButtonState,
  findNewRunId,
  manualRunUnavailableMessage,
} from "../dist/ui/run-feedback.js";

test("manualRunUnavailableMessage explains paused workflows instead of silently disabling Run", () => {
  assert.equal(
    manualRunUnavailableMessage("paused"),
    "Run 불가: paused 상태입니다. Activate 후 다시 실행하세요.",
  );
});

test("buildManualRunButtonState makes paused workflows visibly non-runnable", () => {
  assert.deepEqual(buildManualRunButtonState("paused"), {
    disabled: true,
    label: "Paused — Activate 필요",
    title: "Run 불가: paused 상태입니다. Activate 후 다시 실행하세요.",
    notice: "Run 불가: paused 상태입니다. Activate 후 다시 실행하세요.",
  });
  assert.deepEqual(buildManualRunButtonState("active"), {
    disabled: false,
    label: "▶ Run",
    title: "Start manual workflow run",
    notice: "",
  });
});

test("buildManualRunFeedback includes run id, parent issue, and next location hint", () => {
  assert.equal(
    buildManualRunFeedback("Daily Ops", {
      runId: "run-1234567890",
      parentIssueId: "issue-9876543210",
      parentIssueIdentifier: "CMPAA-72",
    }),
    "Run 시작: Daily Ops · run-1234 · parent issue CMPAA-72 · Active/Recent Runs에서 새 실행이 강조됩니다.",
  );
});

test("findNewRunId prefers action run id and falls back to newly appeared overview runs", () => {
  const beforeIds = new Set(["old-run"]);
  assert.equal(
    findNewRunId(beforeIds, "action-run", [{ id: "new-active" }], [{ id: "new-recent" }]),
    "action-run",
  );
  assert.equal(
    findNewRunId(beforeIds, null, [{ id: "new-active" }], [{ id: "new-recent" }]),
    "new-active",
  );
  assert.equal(
    findNewRunId(beforeIds, null, [], [{ id: "new-recent" }]),
    "new-recent",
  );
});
