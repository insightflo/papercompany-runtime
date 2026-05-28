import assert from "node:assert/strict";
import test from "node:test";

import {
  createStepRun,
  findStepRunByIssueId,
  listStepRuns,
} from "../dist/workflow-store.js";

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

function createMockContext(pageCap = 200) {
  const records = new Map();
  const externalIndex = new Map();

  return {
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
  };
}

test("paginates across all company step runs when listing by run id", async () => {
  const ctx = createMockContext();

  for (let index = 0; index < 201; index += 1) {
    await createStepRun(
      ctx,
      COMPANY_ID,
      makeStepRun({
        runId: `other-run-${index}`,
        stepId: `other-step-${index}`,
        agentName: `Agent ${index}`,
        status: "done",
      }),
    );
  }

  await createStepRun(
    ctx,
    COMPANY_ID,
    makeStepRun({
      runId: "run-target",
      stepId: "collect-market",
      agentName: "system",
      status: "done",
    }),
  );
  await createStepRun(
    ctx,
    COMPANY_ID,
    makeStepRun({
      runId: "run-target",
      stepId: "collect-signals",
      agentName: "system",
      status: "done",
    }),
  );

  const stepRuns = await listStepRuns(ctx, "run-target", COMPANY_ID);

  assert.deepEqual(
    stepRuns.map((stepRun) => stepRun.data.stepId),
    ["collect-market", "collect-signals"],
  );
});

test("paginates across all company step runs when finding by issue id", async () => {
  const ctx = createMockContext();

  for (let index = 0; index < 201; index += 1) {
    await createStepRun(
      ctx,
      COMPANY_ID,
      makeStepRun({
        runId: `other-run-${index}`,
        stepId: `other-step-${index}`,
        agentName: `Agent ${index}`,
        status: "done",
      }),
    );
  }

  const target = await createStepRun(
    ctx,
    COMPANY_ID,
    makeStepRun({
      runId: "run-target",
      stepId: "collect-market",
      agentName: "system",
      status: "done",
    }),
  );
  await ctx.entities.upsert({
    entityType: target.entityType,
    scopeKind: target.scopeKind,
    scopeId: target.scopeId ?? undefined,
    externalId: target.externalId ?? undefined,
    title: target.title ?? undefined,
    status: target.status ?? undefined,
    data: {
      ...target.data,
      issueId: "issue-target",
    },
  });

  const stepRun = await findStepRunByIssueId(ctx, "issue-target", COMPANY_ID);

  assert.equal(stepRun?.id, target.id);
  assert.equal(stepRun?.data.stepId, "collect-market");
});
