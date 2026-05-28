import assert from "node:assert/strict";
import test from "node:test";

import { ensureIssueLabels } from "../dist/issue-labels.js";

function createMockContext(initialLabels = []) {
  const updates = [];
  const issue = {
    id: "issue-1",
    companyId: "company-1",
    labelIds: initialLabels,
  };

  return {
    ctx: {
      issues: {
        async get(issueId, companyId) {
          if (issueId !== issue.id || companyId !== issue.companyId) {
            return null;
          }
          return issue;
        },
        async update(issueId, patch, companyId) {
          updates.push({ issueId, patch, companyId });
          issue.labelIds = patch.labelIds ?? issue.labelIds;
          return issue;
        },
      },
    },
    updates,
    issue,
  };
}

test("ensureIssueLabels updates existing issues that are missing workflow labels", async () => {
  const { ctx, updates, issue } = createMockContext([]);

  await ensureIssueLabels(ctx, issue.id, issue.companyId, ["label-a", "label-b"]);

  assert.equal(updates.length, 1);
  assert.deepEqual(updates[0], {
    issueId: issue.id,
    patch: { labelIds: ["label-a", "label-b"] },
    companyId: issue.companyId,
  });
});

test("ensureIssueLabels skips updates when labels already match", async () => {
  const { ctx, updates, issue } = createMockContext(["label-b", "label-a"]);

  await ensureIssueLabels(ctx, issue.id, issue.companyId, ["label-a", "label-b"]);

  assert.equal(updates.length, 0);
});
