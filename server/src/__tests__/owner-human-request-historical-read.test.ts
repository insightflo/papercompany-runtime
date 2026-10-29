import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Db } from "@paperclipai/db";
import type { OwnerRecoveryApiActor } from "../services/missions/mission-owner-recovery-agent-api.js";
import { lockOwnerHumanRequestAuthority } from "../services/missions/owner-human-request-authority.js";
import { readOwnerHumanCurrent, type OwnerHumanCurrentRecord } from "../services/missions/owner-human-request-state.js";
import { OWNER_HUMAN_LAYER, OWNER_HUMAN_SOURCE } from "../services/missions/owner-human-request-contract.js";
import { buildMissionOwnerHumanInputDecisionCard, type MissionOwnerHumanInputCardSpec }
  from "../services/missions/mission-owner-human-input-card.js";
import { buildHistoricalDefaultOwnerHumanInputVariant }
  from "../services/missions/mission-owner-human-default-definition.js";
import { WORKFLOW_RESTART_FROM_START_OPTION_ID }
  from "../services/missions/workflow-restart-option.js";
import { readOwnerHumanRequest } from "../services/missions/owner-human-request-read.js";
import { validateAndHashOperatorDecisionCreate } from "../services/operator-decision-result.js";

vi.mock("../services/missions/owner-human-request-authority.js", () => ({
  lockOwnerHumanRequestAuthority: vi.fn(), readOwnerToolIdentity: vi.fn(),
}));
vi.mock("../services/missions/owner-human-request-state.js", () => ({ readOwnerHumanCurrent: vi.fn() }));

const makeSpec = (overrides: Partial<MissionOwnerHumanInputCardSpec> = {}): MissionOwnerHumanInputCardSpec => ({
  companyId: randomUUID(), missionId: randomUUID(), decisionEventId: randomUUID(),
  decision: "request_input", ownerActionIssueId: randomUUID(), ownerActionIssueStatus: "blocked",
  requestedByAgentId: randomUUID(), sourceIssueId: randomUUID(), workflowRunId: randomUUID(),
  lifetimeId: randomUUID(), ...overrides,
});

function query(rows: unknown[]) {
  const selection = {
    for: async () => rows,
    then: (resolve: (value: unknown[]) => unknown, reject: (reason: unknown) => unknown) =>
      Promise.resolve(rows).then(resolve, reject),
  };
  return { from: () => ({ where: () => selection }) };
}

function world(options: { historical?: boolean; status?: "pending" | "resolved"; explicit?: boolean } = {}) {
  const spec = makeSpec(options.explicit ? {
    recommendedOptionId: WORKFLOW_RESTART_FROM_START_OPTION_ID,
    recommendationReason: "owner selected restart",
  } : {});
  const { lifetimeId, ...cardSpec } = spec;
  const neutral = buildMissionOwnerHumanInputDecisionCard({ ...cardSpec, lifetimeId });
  const storedInput = options.historical
    ? buildHistoricalDefaultOwnerHumanInputVariant(neutral)!
    : neutral;
  const cardId = randomUUID(), heartbeatRunId = randomUUID();
  const hash = validateAndHashOperatorDecisionCreate(storedInput).requestHash;
  const card = {
    ...storedInput, id: cardId, companyId: spec.companyId, status: options.status ?? "pending",
    requestHash: hash, requestedByAgentId: spec.requestedByAgentId,
    requestedByUserId: null, qualityActionId: null, qualityBinding: null,
    sourceContext: { ...storedInput.sourceContext, planDecisionHash: "server-only" },
    result: options.status === "resolved" ? { actionId: "approve", comment: "accepted" } : null,
    resolvedAt: options.status === "resolved" ? new Date("2026-10-29T00:00:00Z") : null,
    cancelledAt: null,
  };
  const scope = { companyId: spec.companyId, missionId: spec.missionId,
    target: { kind: "source_issue" as const, issueId: spec.sourceIssueId! } };
  const current = {
    pointerEventId: randomUUID(), pointer: { schemaVersion: 1, kind: "owner_human_current_v1",
      scope, lifetimeId, requestKey: storedInput.requestKey, anchorIssueId: spec.ownerActionIssueId,
      revision: 1, recoveryNeeded: true, closure: null },
    lifetime: { schemaVersion: 1, kind: "owner_human_lifetime_v1", lifetimeId, scope,
      requestKey: storedInput.requestKey, identityMode: "keyed", decisionEventId: spec.decisionEventId,
      anchorIssueId: spec.ownerActionIssueId, sourceIssueId: spec.sourceIssueId,
      authorAgentId: spec.requestedByAgentId, heartbeatRunId,
      submission: { decision: spec.decision, recoveryTarget: { kind: "source_issue", issueId: spec.sourceIssueId } },
      cardInput: cardSpec },
  } as unknown as OwnerHumanCurrentRecord;
  const link = {
    companyId: spec.companyId, missionId: spec.missionId, issueId: spec.ownerActionIssueId,
    heartbeatRunId, workflowRunId: spec.workflowRunId, workflowStepRunId: null,
    eventType: "owner_human_card_v1", layer: OWNER_HUMAN_LAYER, reason: OWNER_HUMAN_SOURCE,
    reasonCode: OWNER_HUMAN_SOURCE, idempotencyKey: `owner-human-card:v1:${lifetimeId}`,
    payload: { schemaVersion: 1, kind: "owner_human_card_v1", lifetimeId,
      decisionEventId: spec.decisionEventId, operatorDecisionId: cardId },
  };
  const delivery = {
    id: randomUUID(), companyId: spec.companyId, issueId: spec.ownerActionIssueId,
    targetAgentId: spec.requestedByAgentId, state: "queued", generation: 1, attemptCount: 0,
    wakeupRequestId: null, acceptedAt: null, errorCode: null, errorSummary: null,
  };
  const replies = [
    [{ id: spec.ownerActionIssueId, missionId: spec.missionId }],
    [{ ownerAgentId: spec.requestedByAgentId, status: "active" }],
    [link], [card], [delivery],
  ];
  const tx = { select: vi.fn(() => query(replies.shift() ?? [])) };
  const db = { transaction: async (callback: (tx: unknown) => Promise<unknown>) => callback(tx) } as unknown as Db;
  vi.mocked(lockOwnerHumanRequestAuthority).mockResolvedValue({
    tx, scope, purpose: "settle", anchor: { id: spec.ownerActionIssueId, status: "blocked" },
    source: { id: spec.sourceIssueId, hiddenAt: null, status: "blocked" },
    run: { id: spec.workflowRunId }, agentId: spec.requestedByAgentId, heartbeatRunId,
  } as never);
  vi.mocked(readOwnerHumanCurrent).mockResolvedValue(current);
  const actor = { actorType: "agent", agentId: spec.requestedByAgentId, runId: heartbeatRunId } as OwnerRecoveryApiActor;
  return { spec, db, actor, card, link, delivery };
}

async function read(value: ReturnType<typeof world>) {
  return readOwnerHumanRequest({ db: value.db, companyId: value.spec.companyId,
    issueId: value.spec.ownerActionIssueId, actor: value.actor });
}

describe("current owner human request historical card read", () => {
  beforeEach(() => {
    vi.mocked(lockOwnerHumanRequestAuthority).mockReset();
    vi.mocked(readOwnerHumanCurrent).mockReset();
  });

  it.each([
    { name: "historical pending", historical: true, status: "pending" as const },
    { name: "historical resolved with delivery", historical: true, status: "resolved" as const },
    { name: "neutral new default", historical: false, status: "pending" as const },
    { name: "explicit owner recommendation", historical: false, explicit: true, status: "pending" as const },
  ])("reads $name without changing card or delivery", async (scenario) => {
    const value = world(scenario);
    const hash = value.card.requestHash;
    const result = await read(value);
    expect(result.card).toMatchObject({ id: value.card.id, requestKey: value.card.requestKey,
      status: scenario.status, result: value.card.result });
    expect(result.delivery).toMatchObject({ id: value.delivery.id, state: value.delivery.state,
      targetAgentId: value.spec.requestedByAgentId });
    expect(value.card.requestHash).toBe(hash);
    expect(value.card.definition.options.find((option) => option.id === WORKFLOW_RESTART_FROM_START_OPTION_ID)
      ?.recommended).toBe(scenario.historical || scenario.explicit ? true : undefined);
  });

  it.each(["evidence", "target", "options", "author", "link", "delivery-target"] as const)(
    "rejects a changed %s while reading a historical card", async (damage) => {
      const value = world({ historical: true, status: "resolved" });
      if (damage === "evidence") value.card.definition.humanReview!.interpretation = "changed evidence";
      if (damage === "target") value.card.issueId = randomUUID();
      if (damage === "options") value.card.definition.options[0]!.label = "changed option";
      if (damage === "author") value.card.requestedByAgentId = randomUUID();
      if (damage === "link") value.link.payload.operatorDecisionId = randomUUID();
      if (damage === "delivery-target") value.delivery.targetAgentId = randomUUID();
      await expect(read(value)).rejects.toMatchObject({ status: 409 });
    },
  );
});
