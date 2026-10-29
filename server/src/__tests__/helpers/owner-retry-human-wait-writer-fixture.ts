import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { agents, companies, heartbeatRuns, issues, missions, workflowDefinitions, workflowRuns,
  workflowStepRuns, workflowTransitionEvents, type Db } from "@paperclipai/db";
import type { CreateOperatorDecisionInput } from "@paperclipai/shared/types/operator-decision";
import { buildMissionOwnerHumanInputDecisionCard } from "../../services/missions/mission-owner-human-input-card.js";

export type WriterWorld = {
  companyId: string;
  missionId: string;
  ownerAgentId: string;
  sourceIssueId: string;
  ownerActionIssueId: string;
  heartbeatRunId: string;
  workflowRunId: string;
  stepRunId: string;
  decisionEventId: string;
};

export async function seedOwnerWaitWriterWorld(db: Db, companyId = randomUUID()): Promise<WriterWorld> {
  const world: WriterWorld = {
    companyId, missionId: randomUUID(), ownerAgentId: randomUUID(), sourceIssueId: randomUUID(),
    ownerActionIssueId: randomUUID(), heartbeatRunId: randomUUID(), workflowRunId: randomUUID(),
    stepRunId: randomUUID(), decisionEventId: randomUUID(),
  };
  const [company] = await db.select({ id: companies.id }).from(companies).where(eq(companies.id, companyId));
  if (!company) await db.insert(companies).values({ id: companyId, name: "Human wait writer", issuePrefix: randomUUID() });
  await db.insert(agents).values({ id: world.ownerAgentId, companyId, name: `Owner ${world.missionId}`, status: "active" });
  await db.insert(missions).values({ id: world.missionId, companyId, ownerAgentId: world.ownerAgentId,
    title: `Mission ${world.missionId}`, status: "active" });
  await db.insert(issues).values([
    { id: world.sourceIssueId, companyId, missionId: world.missionId, title: "Source issue", status: "blocked" },
    { id: world.ownerActionIssueId, companyId, missionId: world.missionId, title: "Owner action", status: "in_progress",
      assigneeAgentId: world.ownerAgentId, originKind: "mission_main_executor_unblock", originId: world.sourceIssueId },
  ]);
  await db.insert(heartbeatRuns).values({ id: world.heartbeatRunId, companyId, agentId: world.ownerAgentId,
    issueId: world.ownerActionIssueId, status: "running" });
  const [definition] = await db.insert(workflowDefinitions).values({ companyId, name: `Writer ${world.workflowRunId}`,
    stepsJson: [] }).returning({ id: workflowDefinitions.id });
  await db.insert(workflowRuns).values({ id: world.workflowRunId, companyId, missionId: world.missionId,
    workflowId: definition!.id, triggeredBy: "test", status: "failed" });
  await db.insert(workflowStepRuns).values({ id: world.stepRunId, workflowRunId: world.workflowRunId,
    stepId: "failed-step", status: "failed", executionGeneration: 3 });
  await db.insert(workflowTransitionEvents).values({ id: world.decisionEventId, companyId, missionId: world.missionId,
    workflowRunId: world.workflowRunId, workflowStepRunId: world.stepRunId, issueId: world.ownerActionIssueId,
    heartbeatRunId: world.heartbeatRunId, eventType: "mission_owner_decision", layer: "mission_owner_recovery",
    reason: "owner_recovery_api", reasonCode: "owner_recovery_api", decision: "request_input",
    idempotencyKey: `writer:${world.decisionEventId}`,
    payload: { kind: "mission_owner_decision", source: "owner_recovery_api",
      ownerActionIssueId: world.ownerActionIssueId, sourceIssueId: world.sourceIssueId, decision: "request_input",
      recoveryTarget: { kind: "issue", issueId: world.sourceIssueId } } });
  return world;
}

export function legacyOwnerWaitCardInput(world: WriterWorld): CreateOperatorDecisionInput {
  const card = buildMissionOwnerHumanInputDecisionCard({ companyId: world.companyId, missionId: world.missionId,
    decisionEventId: world.decisionEventId, decision: "request_input", ownerActionIssueId: world.ownerActionIssueId,
    ownerActionIssueStatus: "in_progress", requestedByAgentId: world.ownerAgentId,
    sourceIssueId: world.sourceIssueId, workflowRunId: world.workflowRunId });
  return { ...card, sourceContext: { ...card.sourceContext, targetSnapshot: {
    issueId: world.ownerActionIssueId, issueStatus: "in_progress", workflowRunId: world.workflowRunId,
    workflowRunStatus: "failed", stepRunId: world.stepRunId, stepRunStatus: "failed", executionGeneration: 3,
  } } };
}

export function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

/** Observe the real mission FOR UPDATE query as it is submitted; the database lock is not mocked. */
export function observeMissionLockAttempt(db: Db, reached: () => void): Db {
  function wrapBuilder(builder: object, isMissionQuery = false, observe = false): object {
    return new Proxy(builder, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "then" && observe && typeof value === "function") {
        return (...args: unknown[]) => {
          const result = Reflect.apply(value, target, args);
          reached();
          return result;
        };
      }
      if (typeof value !== "function") return value;
      return (...args: unknown[]) => {
        const next = Reflect.apply(value, target, args);
        const missionQuery = isMissionQuery || (property === "from" && args[0] === missions);
        const nextObserve = observe || (property === "for" && missionQuery && args[0] === "update");
        return next && (typeof next === "object" || typeof next === "function")
          ? wrapBuilder(next, missionQuery, nextObserve) : next;
      };
    } });
  }

  function wrapTransaction(tx: unknown): unknown {
    if (!tx || (typeof tx !== "object" && typeof tx !== "function")) return tx;
    return new Proxy(tx, { get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property === "select" && typeof value === "function") {
        return (...args: unknown[]) => wrapBuilder(Reflect.apply(value, target, args));
      }
      return typeof value === "function" ? value.bind(target) : value;
    } });
  }

  return new Proxy(db, { get(target, property) {
    const value = Reflect.get(target, property, target);
    if (property === "transaction" && typeof value === "function") {
      return (...args: unknown[]) => {
        const callback = args[0];
        if (typeof callback !== "function") return Reflect.apply(value, target, args);
        const wrappedCallback = (tx: unknown) => Reflect.apply(callback, undefined, [wrapTransaction(tx)]);
        return Reflect.apply(value, target, [wrappedCallback, ...args.slice(1)]);
      };
    }
    return typeof value === "function" ? value.bind(target) : value;
  } }) as Db;
}
