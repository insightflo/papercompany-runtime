import assert from "node:assert/strict";
import test from "node:test";

import {
  normalizeCreateParentIssuePolicy,
  shouldCreateParentIssueForRun,
} from "../dist/workflow-parent-policy.js";

test("normalizes parent issue policy to when_multiple_steps by default", () => {
  assert.equal(normalizeCreateParentIssuePolicy(undefined), "when_multiple_steps");
  assert.equal(normalizeCreateParentIssuePolicy("never"), "never");
  assert.equal(normalizeCreateParentIssuePolicy("always"), "always");
  assert.equal(normalizeCreateParentIssuePolicy("when_multiple_steps"), "when_multiple_steps");
  assert.equal(normalizeCreateParentIssuePolicy("legacy"), "when_multiple_steps");
});

test("creates parent issues only when policy or explicit override requires them", () => {
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 1, policy: "when_multiple_steps" }), false);
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 2, policy: "when_multiple_steps" }), true);
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 5, policy: "never" }), false);
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 1, policy: "always" }), true);
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 1, policy: "never", explicitCreateParentIssue: true }), true);
  assert.equal(shouldCreateParentIssueForRun({ stepCount: 5, policy: "always", explicitCreateParentIssue: false }), false);
});
