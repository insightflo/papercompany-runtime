import assert from "node:assert/strict";
import test from "node:test";

import {
  autoCompleteWorkflowStepIssue,
  syncWorkflowStepIssueStatus,
  syncWorkflowStepIssueStatusFromStepRun,
} from "../dist/run-event-utils.js";
import { createStepRun } from "../dist/workflow-store.js";

const COMPANY_ID = "company-workflow-engine-test";

function makeStepRun(overrides = {}) {
  return {
    runId: "run-default",
    stepId: "step-default",
    agentName: "system",
    status: "backlog",
    retryCount: 0,
    ...overrides,
  };
}

function createMockContext(issueStatus = "todo", pageCap = 200) {
  const records = new Map();
  const externalIndex = new Map();
  const updates = [];
  const comments = [];
  const issue = {
    id: "issue-target",
    companyId: COMPANY_ID,
    status: issueStatus,
    labelIds: [],
  };

  return {
    ctx: {
      entities: {
        async upsert(input) {
          const externalKey = input.externalId
            ? `${input.entityType}|${input.scopeKind}|${input.scopeId ?? ""}|${input.externalId}`
            : null;
          const existingId = externalKey ? externalIndex.get(externalKey) : undefined;
          const existing = existingId ? records.get(existingId) : undefined;
          const now = new Date().toISOString();
          const record = existing
            ? {
                ...existing,
                entityType: input.entityType,
                scopeKind: input.scopeKind,
                scopeId: input.scopeId ?? null,
                externalId: input.externalId ?? null,
                title: input.title ?? null,
                status: input.status ?? null,
                data: input.data,
                updatedAt: now,
              }
            : {
                id: `entity-${records.size + 1}`,
                entityType: input.entityType,
                scopeKind: input.scopeKind,
                scopeId: input.scopeId ?? null,
                externalId: input.externalId ?? null,
                title: input.title ?? null,
                status: input.status ?? null,
                data: input.data,
                createdAt: now,
                updatedAt: now,
              };

          records.set(record.id, record);
          if (externalKey) {
            externalIndex.set(externalKey, record.id);
          }
          return record;
        },
        async list(query) {
          let out = [...records.values()];

          if (query.entityType) {
            out = out.filter((record) => record.entityType === query.entityType);
          }
          if (query.scopeKind) {
            out = out.filter((record) => record.scopeKind === query.scopeKind);
          }
          if (query.scopeId) {
            out = out.filter((record) => record.scopeId === query.scopeId);
          }
          if (query.externalId) {
            out = out.filter((record) => record.externalId === query.externalId);
          }

          const offset = typeof query.offset === "number" ? query.offset : 0;
          const limit = typeof query.limit === "number"
            ? Math.min(query.limit, pageCap)
            : pageCap;

          return out.slice(offset, offset + limit);
        },
      },
      issues: {
        async get(issueId, companyId) {
          if (issueId !== issue.id || companyId !== issue.companyId) {
            return null;
          }
          return issue;
        },
        async update(issueId, patch, companyId) {
          if (issueId !== issue.id || companyId !== issue.companyId) {
            throw new Error("unexpected issue update");
          }
          updates.push({ issueId, patch, companyId });
          if (typeof patch.status === "string") {
            issue.status = patch.status;
          }
          return issue;
        },
        async createComment(issueId, body, companyId) {
          if (issueId !== issue.id || companyId !== issue.companyId) {
            throw new Error("unexpected issue comment");
          }
          comments.push({ issueId, body, companyId });
          return {
            id: `comment-${comments.length}`,
            issueId,
            body,
            companyId,
          };
        },
      },
    },
    updates,
    comments,
    issue,
    async seedWorkflowStep() {
      const stepRun = await createStepRun(
        this.ctx,
        COMPANY_ID,
        makeStepRun({
          runId: "run-target",
          stepId: "analyze",
          agentName: "셜록",
          status: "in_progress",
        }),
      );

      await this.ctx.entities.upsert({
        entityType: stepRun.entityType,
        scopeKind: stepRun.scopeKind,
        scopeId: stepRun.scopeId ?? undefined,
        externalId: stepRun.externalId ?? undefined,
        title: stepRun.title ?? undefined,
        status: stepRun.status ?? undefined,
        data: {
          ...stepRun.data,
          issueId: issue.id,
        },
      });

      return stepRun;
    },
  };
}

test("autoCompleteWorkflowStepIssue skips open workflow step issues on finished run", async () => {
  const mock = createMockContext("todo");
  await mock.seedWorkflowStep();

  const result = await autoCompleteWorkflowStepIssue(mock.ctx, {
    companyId: COMPANY_ID,
    eventId: "event-1",
    eventType: "agent.run.finished",
    occurredAt: new Date().toISOString(),
    payload: {
      agent: { id: "agent-1", name: "셜록" },
      context: { issueId: mock.issue.id },
      runId: "run-target",
      stdout: "ok",
    },
  });

  assert.equal(result.completed, false);
  assert.equal(result.issueId, mock.issue.id);
  assert.equal(result.stepId, "analyze");
  assert.equal(result.reason, "issue not terminal (todo)");
  assert.equal(mock.updates.length, 0);
  assert.equal(mock.issue.status, "todo");
});

test("syncWorkflowStepIssueStatus marks failed workflow step issues blocked with a comment", async () => {
  const mock = createMockContext("in_progress");
  await mock.seedWorkflowStep();

  const result = await syncWorkflowStepIssueStatus(mock.ctx, {
    companyId: COMPANY_ID,
    eventId: "event-3",
    eventType: "agent.run.failed",
    occurredAt: new Date().toISOString(),
    payload: {
      issue: { id: mock.issue.id },
      runId: "run-target",
    },
  }, "blocked", {
    comment: "blocked because agent run failed",
  });

  assert.equal(result.completed, true);
  assert.equal(mock.updates.length, 1);
  assert.deepEqual(mock.updates[0], {
    issueId: mock.issue.id,
    patch: { status: "blocked" },
    companyId: COMPANY_ID,
  });
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.comments[0].body, "blocked because agent run failed");
  assert.equal(mock.issue.status, "blocked");
});

test("syncWorkflowStepIssueStatus marks cancelled workflow step issues cancelled", async () => {
  const mock = createMockContext("todo");
  await mock.seedWorkflowStep();

  const result = await syncWorkflowStepIssueStatus(mock.ctx, {
    companyId: COMPANY_ID,
    eventId: "event-4",
    eventType: "agent.run.cancelled",
    occurredAt: new Date().toISOString(),
    payload: {
      context: { issueId: mock.issue.id },
      runId: "run-target",
    },
  }, "cancelled", {
    comment: "cancelled by workflow engine",
  });

  assert.equal(result.completed, true);
  assert.equal(mock.updates.length, 1);
  assert.deepEqual(mock.updates[0], {
    issueId: mock.issue.id,
    patch: { status: "cancelled" },
    companyId: COMPANY_ID,
  });
  assert.equal(mock.comments.length, 1);
  assert.equal(mock.comments[0].body, "cancelled by workflow engine");
  assert.equal(mock.issue.status, "cancelled");
});

test("syncWorkflowStepIssueStatusFromStepRun marks an open workflow step issue done from tool result", async () => {
  const mock = createMockContext("in_progress");
  const stepRun = await mock.seedWorkflowStep();

  const result = await syncWorkflowStepIssueStatusFromStepRun(
    mock.ctx,
    {
      data: {
        ...stepRun.data,
        issueId: mock.issue.id,
      },
    },
    COMPANY_ID,
    "done",
  );

  assert.equal(result.completed, true);
  assert.equal(result.issueId, mock.issue.id);
  assert.equal(result.stepId, "analyze");
  assert.equal(mock.updates.length, 1);
  assert.deepEqual(mock.updates[0], {
    issueId: mock.issue.id,
    patch: { status: "done" },
    companyId: COMPANY_ID,
  });
  assert.equal(mock.issue.status, "done");
});

test("autoCompleteWorkflowStepIssue skips blocked issues", async () => {
  const mock = createMockContext("blocked");
  await mock.seedWorkflowStep();

  const result = await autoCompleteWorkflowStepIssue(mock.ctx, {
    companyId: COMPANY_ID,
    eventId: "event-2",
    eventType: "agent.run.finished",
    occurredAt: new Date().toISOString(),
    payload: {
      issue: { id: mock.issue.id },
      runId: "run-target",
    },
  });

  assert.equal(result.completed, false);
  assert.equal(result.reason, "issue not terminal (blocked)");
  assert.equal(mock.updates.length, 0);
  assert.equal(mock.issue.status, "blocked");
});

test("autoCompleteWorkflowStepIssue accepts workflow step issues already marked done", async () => {
  const mock = createMockContext("done");
  await mock.seedWorkflowStep();

  const result = await autoCompleteWorkflowStepIssue(mock.ctx, {
    companyId: COMPANY_ID,
    eventId: "event-4",
    eventType: "agent.run.finished",
    occurredAt: new Date().toISOString(),
    payload: {
      issue: { id: mock.issue.id },
      runId: "run-target",
    },
  });

  assert.equal(result.completed, true);
  assert.equal(result.issueId, mock.issue.id);
  assert.equal(result.stepId, "analyze");
  assert.equal(mock.updates.length, 0);
  assert.equal(mock.issue.status, "done");
});
