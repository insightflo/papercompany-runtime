import { rmSync } from "node:fs";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { eq, is } from "drizzle-orm";
import { PgTransaction } from "drizzle-orm/pg-core";
import { createDb, agents, agentWakeupRequests, workflowRuns, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { seedReplacement } from "./helpers/replacement-scenario.js";
import { admitReplacement } from "../services/workflow/replacement-admission.js";
import { claimPlainWorkflowStart } from "../services/workflow/plain-start-claim.js";
import { insertWorkflowWakeRequest } from "../services/heartbeat-workflow-wake.js";
import { withReplacementFirstDelivery } from "../services/workflow/replacement-first-delivery.js";
import * as delivery from "../services/workflow/replacement-agent-delivery.js";
import {
  QaCorrectionRootOwnerRequired, isQaCorrectionRootOwnerRequired, queueIssueAssignmentWakeup,
  createReplacementRootNotifications, currentReplacementRootNotifications,
  registerQaCorrectionRootDrain, withReplacementRootNotificationDb,
} from "../services/issue-assignment-wakeup.js";

// C02/C12 mechanism checks: only resume observation is doubled, never DBs, scopes or transactions.
// Public correction delivery, native claim and adapter execution remain later-stage obligations.
const boundary = vi.hoisted(() => ({ service: vi.fn(), resume: vi.fn<(id: string) => Promise<void>>() }));
vi.mock("../services/heartbeat.js", async (original) => ({
  ...await original<typeof import("../services/heartbeat.js")>(),
  heartbeatService: (db: unknown) => {
    boundary.service(db);
    return { resumeQueuedRuns: boundary.resume };
  },
}));
const capture = vi.spyOn(delivery, "withReplacementAgentQueue");
const drain = vi.spyOn(delivery, "drainReplacementRootNotifications");
let temp: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, peer: Db;
const roots: string[] = [];
beforeAll(async () => {
  temp = await startEmbeddedPostgresTestDatabase("c02-root-postcommit-");
  db = createDb(temp.connectionString);
  peer = createDb(temp.connectionString);
}, 60_000);
beforeEach(() => {
  vi.clearAllMocks();
  boundary.resume.mockReset().mockResolvedValue(undefined);
});
afterAll(async () => {
  await peer?.$client.end();
  await db?.$client.end();
  await temp?.cleanup();
  roots.forEach((root) => rmSync(root, { recursive: true, force: true }));
});
async function seed() {
  const s = await seedReplacement(db);
  roots.push(s.tempRoot);
  const target = (await admitReplacement(db, s.input, s.actor)).run;
  expect(await claimPlainWorkflowStart(db, target.id, { activateMission: async () => {} } as never)).toBe("started");
  const [other] = await db.insert(agents).values({
    companyId: s.companyId, name: "Notification peer", role: "operator", status: "active",
  }).returning();
  return { ...s, target, otherAgentId: other.id };
}
async function receipt(id: string) {
  const [run] = await peer.select().from(workflowRuns).where(eq(workflowRuns.id, id));
  return run.metadata?.replacementStart as Record<string, unknown>;
}
const requests = (companyId: string) => peer.select().from(agentWakeupRequests)
  .where(eq(agentWakeupRequests.companyId, companyId));
// A real ordinary queue write proves atomicity; this is not a fabricated correction authority.
async function enqueue(tx: Db, s: Awaited<ReturnType<typeof seed>>) {
  const [request] = await insertWorkflowWakeRequest(tx, {
    companyId: s.companyId, agentId: s.ownerAgentId, source: "assignment",
    issueId: s.oversightIssueId, missionId: s.mission.id, requestKind: "create",
    requestedByActorType: "system", status: "queued",
  });
  return request;
}
it("commits receipt and queue before one sorted A/A/B drain through the original root", async () => {
  const s = await seed();
  let transaction!: Db;
  boundary.resume.mockImplementation(async () => {
    expect((await receipt(s.target.id)).deliveredAt).toEqual(expect.any(String));
    expect(await requests(s.companyId)).toHaveLength(1);
    expect(currentReplacementRootNotifications(transaction)).toBeNull();
  });
  await expect(withReplacementFirstDelivery(db, s.target.id, async (tx) => {
    transaction = tx;
    expect(is(tx, PgTransaction)).toBe(true);
    registerQaCorrectionRootDrain(tx, s.otherAgentId);
    registerQaCorrectionRootDrain(tx, s.ownerAgentId);
    registerQaCorrectionRootDrain(tx, s.ownerAgentId);
    await enqueue(tx, s);
    expect((await receipt(s.target.id)).deliveredAt).toBeNull();
    expect(await requests(s.companyId)).toEqual([]);
    expect(boundary.resume).not.toHaveBeenCalled();
    expect(boundary.service).not.toHaveBeenCalled();
    return "delivered";
  })).resolves.toBe("delivered");
  expect(drain).toHaveBeenCalledTimes(1);
  expect(drain.mock.calls[0][0] === db).toBe(true);
  expect(boundary.service).toHaveBeenCalledTimes(1);
  expect(boundary.service.mock.calls[0][0] === db).toBe(true);
  expect(boundary.resume.mock.calls.map(([id]) => id)).toEqual([s.ownerAgentId, s.otherAgentId].sort());
  expect(capture).toHaveBeenCalledTimes(1);
});
it.each(["callback", "receipt"])("rolls back all writes and never drains after %s failure", async (kind) => {
  const s = await seed();
  let transaction!: Db;
  if (kind === "receipt") await db.$client.unsafe(`CREATE FUNCTION fail_postcommit_receipt() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
    IF NEW.id='${s.target.id}'::uuid AND NEW.metadata->'replacementStart'->>'deliveredAt' IS NOT NULL THEN RAISE EXCEPTION 'receipt crash'; END IF;
    RETURN NEW; END $$; CREATE TRIGGER fail_postcommit_receipt BEFORE UPDATE ON workflow_runs FOR EACH ROW EXECUTE FUNCTION fail_postcommit_receipt()`);
  try {
    await expect(withReplacementFirstDelivery(db, s.target.id, async (tx) => {
      transaction = tx;
      registerQaCorrectionRootDrain(tx, s.ownerAgentId);
      await enqueue(tx, s);
      if (kind === "callback") throw new Error("callback crash");
    })).rejects.toThrow(kind === "callback" ? "callback crash" : "receipt crash");
  } finally {
    if (kind === "receipt") await db.$client.unsafe("DROP TRIGGER fail_postcommit_receipt ON workflow_runs; DROP FUNCTION fail_postcommit_receipt()");
  }
  expect(await requests(s.companyId)).toEqual([]);
  expect((await receipt(s.target.id)).deliveredAt).toBeNull();
  expect(currentReplacementRootNotifications(transaction)).toBeNull();
  expect(drain).not.toHaveBeenCalled();
  expect(boundary.service).not.toHaveBeenCalled();
});
it("keeps the committed receipt and queue when postcommit resume fails", async () => {
  const s = await seed();
  const failure = new Error("resume failed after commit");
  boundary.resume.mockRejectedValue(failure);
  await expect(withReplacementFirstDelivery(db, s.target.id, async (tx) => {
    registerQaCorrectionRootDrain(tx, s.ownerAgentId);
    await enqueue(tx, s);
  })).rejects.toBe(failure);
  expect((await receipt(s.target.id)).deliveredAt).toEqual(expect.any(String));
  expect(await requests(s.companyId)).toHaveLength(1);
  expect(drain).toHaveBeenCalledTimes(1);
});
it("binds deliveredAt reentry without repeating the special first-delivery capture", async () => {
  const s = await seed();
  await withReplacementFirstDelivery(db, s.target.id, async () => {});
  expect(boundary.service).not.toHaveBeenCalled();
  const committed = await receipt(s.target.id);
  capture.mockClear();
  drain.mockClear();
  let transaction!: Db;
  await withReplacementFirstDelivery(db, s.target.id, async (tx) => {
    transaction = tx;
    expect(currentReplacementRootNotifications(tx)).not.toBeNull();
    registerQaCorrectionRootDrain(tx, s.ownerAgentId);
  });
  expect(await receipt(s.target.id)).toEqual(committed);
  expect(currentReplacementRootNotifications(transaction)).toBeNull();
  expect(capture).not.toHaveBeenCalled();
  expect(drain).toHaveBeenCalledTimes(1);
  expect(boundary.resume.mock.calls.map(([id]) => id)).toEqual([s.ownerAgentId]);
});
it("inherits exact bindings through a real savepoint and never drains inside the outer transaction", async () => {
  const s = await seed();
  let inner!: Db;
  await withReplacementFirstDelivery(db, s.target.id, async (outer) => {
    const notifications = currentReplacementRootNotifications(outer);
    expect(notifications).not.toBeNull();
    registerQaCorrectionRootDrain(outer, s.ownerAgentId);
    await withReplacementFirstDelivery(outer, s.target.id, async (savepoint) => {
      inner = savepoint;
      expect(is(savepoint, PgTransaction)).toBe(true);
      expect(savepoint === outer).toBe(false);
      expect(currentReplacementRootNotifications(savepoint)).toBe(notifications);
      registerQaCorrectionRootDrain(savepoint, s.ownerAgentId);
      registerQaCorrectionRootDrain(savepoint, s.otherAgentId);
    });
    expect(currentReplacementRootNotifications(inner)).toBeNull();
    expect(currentReplacementRootNotifications(outer)).toBe(notifications);
    expect(drain).not.toHaveBeenCalled();
    expect(boundary.service).not.toHaveBeenCalled();
    expect((await receipt(s.target.id)).deliveredAt).toBeNull();
  });
  expect(drain).toHaveBeenCalledTimes(1);
  expect(boundary.resume.mock.calls.map(([id]) => id)).toEqual([s.ownerAgentId, s.otherAgentId].sort());
});
it("preserves unscoped ordinary nested delivery and queued B while correction registration fails", async () => {
  const s = await seed();
  const b = await enqueue(db, s);
  await db.transaction(async (tx) => {
    const actual = tx as unknown as Db;
    await expect(withReplacementFirstDelivery(actual, s.target.id, async (nested) => {
      expect(currentReplacementRootNotifications(nested)).toBeNull();
      return "ordinary";
    })).resolves.toBe("ordinary");
    await expect(withReplacementFirstDelivery(actual, s.target.id, async (nested) => {
      registerQaCorrectionRootDrain(nested, s.ownerAgentId);
    })).rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
    expect(currentReplacementRootNotifications(actual)).toBeNull();
  });
  expect(await requests(s.companyId)).toEqual([b]);
  expect(drain).not.toHaveBeenCalled();
  expect(boundary.service).not.toHaveBeenCalled();
});
it("restores previous exact bindings on failure, leaks none and refuses transaction drains even when empty", async () => {
  const outer = createReplacementRootNotifications();
  const inner = createReplacementRootNotifications();
  const failure = new Error("binding failure");
  let actual!: Db;
  await db.transaction(async (tx) => {
    actual = tx as unknown as Db;
    await withReplacementRootNotificationDb(actual, outer, async () => {
      expect(currentReplacementRootNotifications(db)).toBeNull();
      expect(() => registerQaCorrectionRootDrain(peer, "unbound")).toThrow(QaCorrectionRootOwnerRequired);
      await expect(withReplacementRootNotificationDb(actual, inner, async () => {
        expect(currentReplacementRootNotifications(actual)).toBe(inner);
        throw failure;
      })).rejects.toBe(failure);
      expect(currentReplacementRootNotifications(actual)).toBe(outer);
      await withReplacementRootNotificationDb(actual, inner, async () => {
        expect(currentReplacementRootNotifications(actual)).toBe(inner);
      });
      expect(currentReplacementRootNotifications(actual)).toBe(outer);
      await expect(delivery.drainReplacementRootNotifications(actual, inner)).rejects.toBeInstanceOf(QaCorrectionRootOwnerRequired);
    });
    expect(currentReplacementRootNotifications(actual)).toBeNull();
  });
  expect(currentReplacementRootNotifications(actual)).toBeNull();
  expect(currentReplacementRootNotifications(peer)).toBeNull();
  await delivery.drainReplacementRootNotifications(db, outer);
  expect(boundary.service).not.toHaveBeenCalled();
});
it("preserves authority-free delivery with the exact input DB", async () => {
  const s = await seed();
  await expect(withReplacementFirstDelivery(db, s.run.id, async (actual) => {
    expect(actual === db).toBe(true);
    expect(currentReplacementRootNotifications(actual)).toBeNull();
    return "unchanged";
  })).resolves.toBe("unchanged");
  expect(capture).not.toHaveBeenCalled();
  expect(drain).not.toHaveBeenCalled();
});
it("recognizes direct and deep typed causes, terminates cycles and preserves assignment error policy", async () => {
  const typed = new QaCorrectionRootOwnerRequired();
  let wrapped: unknown = typed;
  for (let depth = 0; depth < 8; depth++) wrapped = new Error("wrapped", { cause: wrapped });
  const cycle: { cause?: unknown } = {};
  cycle.cause = cycle;
  const ordinary = Object.assign(new Error(typed.message), { code: typed.code });
  expect(isQaCorrectionRootOwnerRequired(typed)).toBe(true);
  expect(isQaCorrectionRootOwnerRequired(wrapped)).toBe(true);
  expect(isQaCorrectionRootOwnerRequired(cycle)).toBe(false);
  expect(isQaCorrectionRootOwnerRequired(ordinary)).toBe(false);
  const assign = (error: unknown, rethrowOnError = false) => queueIssueAssignmentWakeup({
    heartbeat: { wakeup: async () => { throw error; } },
    issue: { id: "mechanism-issue", assigneeAgentId: "mechanism-agent", status: "todo" },
    reason: "issue_assigned", mutation: "create", contextSource: "test", rethrowOnError,
  });
  await expect(assign(typed)).rejects.toBe(typed);
  await expect(assign(wrapped)).rejects.toBe(wrapped);
  await expect(assign(ordinary)).resolves.toBeNull();
  await expect(assign(ordinary, true)).rejects.toBe(ordinary);
});
