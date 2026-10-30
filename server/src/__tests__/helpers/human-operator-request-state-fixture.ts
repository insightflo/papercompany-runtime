import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import type Postgres from "../../../../packages/db/node_modules/postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import {
  activityLog, agentWakeupRequests, agents, companies, getEmbeddedPostgresTestSupport, heartbeatRuns, issues,
  missions, operatorDecisionContinuations, operatorDecisions, startEmbeddedPostgresTestDatabase, type Db,
} from "@paperclipai/db";
import * as schema from "@paperclipai/db/schema/index";
import { and, eq, inArray } from "drizzle-orm";
import { HUMAN_OPERATOR_REQUEST_ACTION } from "../../services/missions/human-operator-alert-events.js";

const requireDbPackage = createRequire(new URL("../../../../packages/db/package.json", import.meta.url));
const postgres = requireDbPackage("postgres") as typeof Postgres;

type CardInsert = Omit<typeof operatorDecisions.$inferInsert, "sourceContext"> & {
  sourceContext: NonNullable<typeof operatorDecisions.$inferInsert.sourceContext> & {
    targetSnapshot: { issueId: string; workflowRunId: string | null };
  };
};

export type RequestWorld = { companyId: string; agentId: string; missionId: string; ownerId: string; sourceId: string };
export type ActivityInput = {
  id?: string; ownerId?: string; sourceId?: string | null; decision?: "request_input" | "escalate";
  runId?: string; companyId?: string; payloadIssueId?: string; payloadMissionId?: string;
  createdAt?: Date; extra?: Record<string, unknown>;
};
export type CardInput = {
  eventId: string; requestKey?: string; status?: "pending" | "resolved" | "cancelled"; ownerId?: string;
  sourceType?: string; companyId?: string; missionId?: string; snapshotIssueId?: string;
  runId?: string | null; snapshotRunId?: string | null; lastSeen?: string; createdAt?: Date;
  continuationMode?: "none" | "issue_current_assignee";
};
export type DeliveryInput = {
  state: "pending" | "accepted" | "exhausted" | "blocked"; wakeupStatus?: string; runStatus?: string;
  missingWakeup?: boolean; missingRun?: boolean; continuationCompanyId?: string; wakeupCompanyId?: string;
  wakeupAgentId?: string; issueId?: string | null; targetAgentId?: string | null;
  generation?: number; manualRetryCount?: number; attemptCount?: number; errorCode?: string | null;
};

type Snapshot = {
  decisions: unknown[]; continuations: unknown[]; wakeups: unknown[]; runs: unknown[];
};

export type HumanRequestFixture = {
  db: Db;
  queries: string[];
  queryParams: unknown[][];
  clearQueries(): void;
  reset(): Promise<void>;
  close(): Promise<void>;
  createWorld(input?: { ownerStatus?: string; sourceStatus?: string; missionStatus?: string }): Promise<RequestWorld>;
  createOwnerIssues(world: RequestWorld, count: number): Promise<string[]>;
  activity(world: RequestWorld, eventId: string, input?: ActivityInput): typeof activityLog.$inferInsert;
  addActivity(world: RequestWorld, eventId: string, input?: ActivityInput): Promise<void>;
  addActivities(rows: Array<ReturnType<HumanRequestFixture["activity"]>>): Promise<void>;
  cardValues(world: RequestWorld, input: CardInput): CardInsert;
  addCard(world: RequestWorld, input: CardInput): Promise<string>;
  addDelivery(world: RequestWorld, decisionId: string, input: DeliveryInput): Promise<string>;
  snapshot(): Promise<Snapshot>;
  indexNames(): Promise<string[]>;
};

export async function embeddedRequestStateSupported(): Promise<boolean> {
  return (await getEmbeddedPostgresTestSupport()).supported;
}

export async function startHumanRequestFixture(): Promise<HumanRequestFixture> {
  const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-human-operator-listing-");
  const client = postgres(tempDb.connectionString);
  const queries: string[] = [];
  const queryParams: unknown[][] = [];
  const db: Db = drizzle(client, { schema, logger: { logQuery: (query, params) => { queries.push(query); queryParams.push(params); } } });

  async function createWorld(input: { ownerStatus?: string; sourceStatus?: string; missionStatus?: string } = {}): Promise<RequestWorld> {
    const companyId = randomUUID(), agentId = randomUUID(), missionId = randomUUID(), ownerId = randomUUID(), sourceId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Human Operator Co", issuePrefix: `HO${companyId.slice(0, 6)}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Mission Owner", role: "ceo", status: "active", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {}, permissions: {} });
    await db.insert(missions).values({ id: missionId, companyId, ownerAgentId: agentId, title: "Human operator routing mission", status: input.missionStatus ?? "active" });
    await db.insert(issues).values([
      { id: ownerId, companyId, missionId, title: "owner unblock action", status: input.ownerStatus ?? "blocked", assigneeAgentId: agentId, originKind: "mission_main_executor_unblock", originId: sourceId },
      { id: sourceId, companyId, missionId, title: "source blocked deliverable", status: input.sourceStatus ?? "blocked" },
    ]);
    return { companyId, agentId, missionId, ownerId, sourceId };
  }

  async function createOwnerIssues(world: RequestWorld, count: number): Promise<string[]> {
    const ids = Array.from({ length: count }, () => randomUUID());
    if (ids.length) await db.insert(issues).values(ids.map((id, index) => ({
      id, companyId: world.companyId, missionId: world.missionId,
      title: `additional owner ${index}`, status: "blocked", assigneeAgentId: world.agentId,
      originKind: "mission_main_executor_unblock", originId: world.sourceId,
    })));
    return ids;
  }

  function activity(world: RequestWorld, eventId: string, input: ActivityInput = {}) {
    const ownerId = input.ownerId ?? world.ownerId;
    return {
      ...(input.id ? { id: input.id } : {}), companyId: input.companyId ?? world.companyId,
      actorType: "agent" as const, actorId: world.agentId, action: HUMAN_OPERATOR_REQUEST_ACTION,
      entityType: "issue", entityId: ownerId, createdAt: input.createdAt,
      details: {
        missionId: input.payloadMissionId ?? world.missionId,
        issueId: input.payloadIssueId ?? ownerId,
        ...(input.sourceId === null ? {} : { sourceIssueId: input.sourceId ?? world.sourceId }),
        decisionEventId: eventId, decision: input.decision ?? "escalate", actorType: "agent", actorId: world.agentId,
        ...(input.runId ? { workflowRunId: input.runId } : {}), ...input.extra,
      },
    };
  }

  function cardValues(world: RequestWorld, input: CardInput): CardInsert {
    const id = randomUUID(), status = input.status ?? "resolved", now = input.createdAt ?? new Date();
    const runId = input.runId ?? null;
    return {
      id, companyId: input.companyId ?? world.companyId, requestKey: input.requestKey ?? `moi2:${randomUUID()}`,
      requestHash: randomUUID(), interactionType: "single_select", title: "Human decision",
      sourceType: input.sourceType ?? "mission_owner_human_input", sourceId: input.eventId,
      issueId: input.ownerId ?? world.ownerId,
      sourceContext: {
        missionId: input.missionId ?? world.missionId, workflowId: null, workflowRunId: runId, artifactRefs: [],
        targetSnapshot: { issueId: input.snapshotIssueId ?? input.ownerId ?? world.ownerId, workflowRunId: input.snapshotRunId ?? runId },
        ...(input.lastSeen ? { missionOwnerHumanInput: { repeatCount: 2, lastSeenDecisionEventId: input.lastSeen } } : {}),
      },
      definition: { options: [], actions: [], selection: null, comment: { mode: "optional", label: null, placeholder: null, maxLength: 500 }, approvedScope: [], forbiddenScope: [] },
      status, result: status === "resolved" ? { actionId: "approve", outcome: "approve", selectedOptionIds: ["approve"], comment: "approved" } : null,
      resolvedByUserId: status === "resolved" ? "human-operator" : null,
      resolvedAt: status === "resolved" ? now : null, cancelledAt: status === "cancelled" ? now : null,
      continuationMode: input.continuationMode ?? "issue_current_assignee", requestedByAgentId: world.agentId, createdAt: now,
    };
  }

  async function addDelivery(world: RequestWorld, decisionId: string, input: DeliveryInput): Promise<string> {
    const wakeupId = input.wakeupStatus || input.missingWakeup ? randomUUID() : null;
    const runId = input.runStatus || input.missingRun ? randomUUID() : null;
    const wakeupCompanyId = input.wakeupCompanyId ?? world.companyId;
    const wakeupAgentId = input.wakeupAgentId ?? world.agentId;
    if (input.runStatus) await db.insert(heartbeatRuns).values({ id: runId!, companyId: wakeupCompanyId, agentId: wakeupAgentId, status: input.runStatus });
    if (input.wakeupStatus) await db.insert(agentWakeupRequests).values({
      id: wakeupId!, companyId: wakeupCompanyId, agentId: wakeupAgentId, source: "assignment",
      status: input.wakeupStatus, runId,
    });
    const generation = input.generation ?? 1;
    await db.insert(operatorDecisionContinuations).values({
      companyId: input.continuationCompanyId ?? world.companyId, operatorDecisionId: decisionId,
      issueId: input.issueId === undefined ? world.ownerId : input.issueId, state: input.state,
      generation, manualRetryCount: input.manualRetryCount ?? generation - 1,
      attemptCount: input.attemptCount ?? (input.state === "exhausted" ? 3 : 0), maxAttempts: 3,
      targetAgentId: input.targetAgentId === undefined ? world.agentId : input.targetAgentId,
      wakeupRequestId: wakeupId, idempotencyKey: input.state === "accepted" ? `operator-decision-wake:${randomUUID()}` : null,
      acceptedAt: input.state === "accepted" ? new Date() : null, nextAttemptAt: new Date(Date.now() + 60_000),
      errorCode: input.errorCode ?? null,
    });
    return wakeupId ?? "";
  }

  async function snapshot(): Promise<Snapshot> {
    const [decisions, continuations, wakeups, runs] = await Promise.all([
      db.select().from(operatorDecisions).orderBy(operatorDecisions.id),
      db.select().from(operatorDecisionContinuations).orderBy(operatorDecisionContinuations.id),
      db.select().from(agentWakeupRequests).orderBy(agentWakeupRequests.id),
      db.select().from(heartbeatRuns).orderBy(heartbeatRuns.id),
    ]);
    return { decisions, continuations, wakeups, runs };
  }

  return {
    db, queries,
    queryParams,
    clearQueries: () => { queries.length = 0; queryParams.length = 0; },
    reset: async () => {
      queries.length = 0; queryParams.length = 0;
      await db.delete(activityLog);
      await db.delete(operatorDecisionContinuations);
      await db.delete(operatorDecisions);
      await db.delete(heartbeatRuns);
      await db.delete(agentWakeupRequests);
      await db.delete(issues);
      await db.delete(missions);
      await db.delete(agents);
      await db.delete(companies);
    },
    close: async () => { await client.end(); await tempDb.cleanup(); },
    createWorld,
    createOwnerIssues,
    activity,
    addActivity: async (world, eventId, input = {}) => { await db.insert(activityLog).values(activity(world, eventId, input)); },
    addActivities: async (rows) => { if (rows.length) await db.insert(activityLog).values(rows); },
    cardValues,
    addCard: async (world, input) => { const row = cardValues(world, input); await db.insert(operatorDecisions).values(row); return row.id; },
    addDelivery,
    snapshot,
    indexNames: async () => {
      const rows = await client.unsafe("select indexname from pg_indexes where schemaname = 'public' and tablename in ('operator_decisions', 'operator_decision_continuations', 'agent_wakeup_requests', 'heartbeat_runs', 'issues', 'agents')");
      return rows.map((row) => String(row.indexname));
    },
  };
}
