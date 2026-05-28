import assert from "node:assert/strict";
import test from "node:test";

import {
  findRecentScheduledSlot,
  runScheduledWorkflows,
  setStartWorkflowFn,
} from "../dist/reconciler.js";

test("findRecentScheduledSlot backfills an exact hourly schedule within the grace window", () => {
  const now = new Date("2026-04-17T08:11:00+09:00");
  const slot = findRecentScheduledSlot("0 8 * * *", now);

  assert.ok(slot);
  assert.equal(slot?.toISOString(), "2026-04-16T23:00:00.000Z");
});

test("findRecentScheduledSlot returns the most recent exact slot for stepped minute schedules", () => {
  const now = new Date("2026-04-17T08:11:00+09:00");
  const slot = findRecentScheduledSlot("*/5 8 * * *", now);

  assert.ok(slot);
  assert.equal(slot?.toISOString(), "2026-04-16T23:10:00.000Z");
});

test("findRecentScheduledSlot stops matching after the grace window passes", () => {
  const now = new Date("2026-04-17T08:16:00+09:00");
  const slot = findRecentScheduledSlot("0 8 * * *", now);

  assert.equal(slot, null);
});

function createSchedulerContext(definition) {
  const records = new Map([[definition.id, definition]]);
  const externalIndex = new Map([
    [`${definition.entityType}|${definition.scopeKind}|${definition.scopeId}|${definition.externalId}`, definition.id],
  ]);

  return {
    logger: {
      info() {},
      warn() {},
    },
    entities: {
      async list(query) {
        let out = [...records.values()];
        if (query.entityType) out = out.filter((record) => record.entityType === query.entityType);
        if (query.scopeKind) out = out.filter((record) => record.scopeKind === query.scopeKind);
        if (query.scopeId) out = out.filter((record) => record.scopeId === query.scopeId);
        const offset = typeof query.offset === "number" ? query.offset : 0;
        const limit = typeof query.limit === "number" ? query.limit : out.length;
        return out.slice(offset, offset + limit);
      },
      async upsert(input) {
        const key = `${input.entityType}|${input.scopeKind}|${input.scopeId ?? ""}|${input.externalId}`;
        const existingId = externalIndex.get(key);
        const id = existingId ?? `entity-${records.size + 1}`;
        const existing = records.get(id);
        const record = {
          id,
          entityType: input.entityType,
          scopeKind: input.scopeKind,
          scopeId: input.scopeId ?? null,
          externalId: input.externalId ?? null,
          title: input.title ?? null,
          status: input.status ?? null,
          data: input.data,
          createdAt: existing?.createdAt ?? new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
        records.set(id, record);
        externalIndex.set(key, id);
        return record;
      },
    },
    getDefinition() {
      return records.get(definition.id);
    },
  };
}

test("runScheduledWorkflows claims the scheduled slot before starting workflow work", async () => {
  const definition = {
    id: "workflow-1",
    entityType: "workflow-definition",
    scopeKind: "company",
    scopeId: "company-1",
    externalId: "workflow-definition:company-1:workflow-1",
    title: "daily workflow",
    status: "active",
    data: {
      name: "daily workflow",
      description: "test workflow",
      companyId: "company-1",
      status: "active",
      schedule: "* * * * *",
      maxDailyRuns: 0,
      steps: [],
    },
  };
  const ctx = createSchedulerContext(definition);
  let starts = 0;

  setStartWorkflowFn(async () => {
    starts += 1;
    if (starts === 1) {
      await runScheduledWorkflows(ctx);
    }
    return { runId: `run-${starts}` };
  });

  await runScheduledWorkflows(ctx);

  assert.equal(starts, 1);
  assert.match(ctx.getDefinition().data.lastScheduledRunAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:00\.000Z$/);
});
