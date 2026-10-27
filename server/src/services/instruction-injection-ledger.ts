import path from "node:path";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionInjections, issueExecutionCards } from "@paperclipai/db";
import {
  hashLoadedInstructions,
  loadInstructionsWithInlinedReferences,
} from "@paperclipai/adapter-utils/instructions";
import { parseObject } from "../adapters/utils.js";

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/**
 * [wake envelope diet] 세션이 회전(재시작)되는 웨이크에서는 compact stub이 거짓말을 한다
 *   ("이전 실행에서 이미 주입됨" — 하지만 새 세션에는 그 내용이 없다).
 *   회전 신호가 있으면 항상 full 재주입한다(부트스트랩 1회 + 해시 델타의 회전 예외).
 */
function wakeRotatesSession(context: Record<string, unknown>): boolean {
  if (context.forceFreshSession === true) return true;
  if (readNonEmptyString(context.paperclipSessionRotationReason)) return true;
  const reworkContract = parseObject(context.paperclipWorkflowReworkContract);
  return readNonEmptyString(reworkContract.kind) === "workflow_qa_rework";
}

function resolveInstructionsPath(adapterConfig: Record<string, unknown>, cwd: string): string | null {
  const raw = typeof adapterConfig.instructionsFilePath === "string"
    ? adapterConfig.instructionsFilePath.trim()
    : "";
  if (!raw) return null;
  return path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
}

async function issueHasExecutionCard(input: {
  db: Db;
  companyId: string;
  issueId: string;
}) {
  const row = await input.db
    .select({ id: issueExecutionCards.id })
    .from(issueExecutionCards)
    .where(and(
      eq(issueExecutionCards.companyId, input.companyId),
      eq(issueExecutionCards.issueId, input.issueId),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  return row !== null;
}

export type InstructionInjectionPlan = {
  companyId: string;
  issueId: string;
  agentId: string;
  adapterType: string;
  instructionsPath: string;
  entryPath: string;
  includedPaths: string[];
  deferredPaths: string[];
  warnings: string[];
  contentHash: string;
  deliveryToken: string;
  mode: "full" | "compact";
  plannedProviderSessionId: string | null;
};

function writePlanToContext(
  context: Record<string, unknown>,
  plan: InstructionInjectionPlan,
) {
  delete context.paperclipInstructionInjectionDelivery;
  context.paperclipInstructionInjection = {
    mode: plan.mode,
    entryPath: plan.entryPath,
    contentHash: plan.contentHash,
    includedPaths: plan.includedPaths,
    deferredPaths: plan.deferredPaths,
    deliveryToken: plan.deliveryToken,
  };
}

export async function prepareInstructionInjection(input: {
  db: Db;
  context: Record<string, unknown>;
  agent: { id: string; companyId: string; adapterType: string };
  issueId: string | null;
  adapterConfig: Record<string, unknown>;
  cwd: string;
  runId: string;
  providerSessionId: string | null;
}): Promise<InstructionInjectionPlan | null> {
  // [주의 — P0c] issueId가 null인 run(sidebar/Telegram 자유대화, timer)은 이 벡터(AGENTS.md
  //   reference 파일, issue+execution-card 스코프)를 받지 않는다. Hermes Ops liaison의 필수
  //   safety/monitoring 규칙은 vector-1(HERMES_OPERATIONS_LIAISON_BRIEF, -q prompt로 무조건 전달)
  //   에 있어야 이 경로에서도 도달한다. reference 파일은 보조 자료만 담을 것.
  if (!input.issueId) {
    delete input.context.paperclipInstructionInjection;
    return null;
  }
  if (!await issueHasExecutionCard({
    db: input.db,
    companyId: input.agent.companyId,
    issueId: input.issueId,
  })) {
    delete input.context.paperclipInstructionInjection;
    return null;
  }

  const instructionsPath = resolveInstructionsPath(input.adapterConfig, input.cwd);
  if (!instructionsPath) {
    delete input.context.paperclipInstructionInjection;
    return null;
  }

  const loaded = await loadInstructionsWithInlinedReferences(instructionsPath);
  const injectionJson = {
    entryPath: loaded.entryPath,
    includedPaths: loaded.includedPaths,
    deferredPaths: loaded.deferredPaths,
    warnings: loaded.warnings,
    contentHash: hashLoadedInstructions(loaded),
  };
  const previous = await input.db
    .select()
    .from(agentInstructionInjections)
    .where(and(
      eq(agentInstructionInjections.companyId, input.agent.companyId),
      eq(agentInstructionInjections.issueId, input.issueId),
      eq(agentInstructionInjections.agentId, input.agent.id),
      eq(agentInstructionInjections.adapterType, input.agent.adapterType),
      eq(agentInstructionInjections.instructionsPath, instructionsPath),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  const previousJson = parseObject(previous?.lastInjectionJson);
  const providerSessionId = readNonEmptyString(input.providerSessionId);
  const compact = !wakeRotatesSession(input.context)
    && providerSessionId !== null
    && previous?.contentHash === injectionJson.contentHash
    && readNonEmptyString(previousJson.providerSessionId) === providerSessionId;
  const plan: InstructionInjectionPlan = {
    companyId: input.agent.companyId,
    issueId: input.issueId,
    agentId: input.agent.id,
    adapterType: input.agent.adapterType,
    instructionsPath,
    ...injectionJson,
    deliveryToken: `${input.runId}:${randomUUID()}`,
    mode: compact ? "compact" : "full",
    plannedProviderSessionId: providerSessionId,
  };
  writePlanToContext(input.context, plan);
  return plan;
}

export function forceFullInstructionInjection(
  context: Record<string, unknown>,
  plan: InstructionInjectionPlan | null,
): InstructionInjectionPlan | null {
  if (!plan) return null;
  const fullPlan = plan.mode === "full" ? plan : { ...plan, mode: "full" as const };
  writePlanToContext(context, fullPlan);
  return fullPlan;
}

export async function confirmInstructionInjectionDelivery(input: {
  db: Db;
  context: Record<string, unknown>;
  plan: InstructionInjectionPlan | null;
  providerSessionId: string | null;
  adapterProcessStarted: boolean;
}): Promise<boolean> {
  const { plan } = input;
  const providerSessionId = readNonEmptyString(input.providerSessionId);
  if (!plan || !input.adapterProcessStarted || !providerSessionId) return false;
  if (plan.mode === "compact" && providerSessionId !== plan.plannedProviderSessionId) return false;

  const delivery = parseObject(input.context.paperclipInstructionInjectionDelivery);
  if (
    delivery.version !== 1
    || delivery.state !== "prepared"
    || delivery.deliveryToken !== plan.deliveryToken
    || delivery.mode !== plan.mode
    || delivery.contentHash !== plan.contentHash
    || delivery.entryPath !== plan.entryPath
  ) return false;

  const existing = await input.db
    .select()
    .from(agentInstructionInjections)
    .where(and(
      eq(agentInstructionInjections.companyId, plan.companyId),
      eq(agentInstructionInjections.issueId, plan.issueId),
      eq(agentInstructionInjections.agentId, plan.agentId),
      eq(agentInstructionInjections.adapterType, plan.adapterType),
      eq(agentInstructionInjections.instructionsPath, plan.instructionsPath),
    ))
    .limit(1)
    .then((rows) => rows[0] ?? null);
  if (readNonEmptyString(parseObject(existing?.lastInjectionJson).deliveryToken) === plan.deliveryToken) {
    return true;
  }

  const now = new Date();
  const lastInjectionJson = {
    entryPath: plan.entryPath,
    includedPaths: plan.includedPaths,
    deferredPaths: plan.deferredPaths,
    warnings: plan.warnings,
    contentHash: plan.contentHash,
    providerSessionId,
    deliveryToken: plan.deliveryToken,
    mode: plan.mode,
    deliveredAt: now.toISOString(),
  };
  await input.db
    .insert(agentInstructionInjections)
    .values({
      companyId: plan.companyId,
      issueId: plan.issueId,
      agentId: plan.agentId,
      adapterType: plan.adapterType,
      instructionsPath: plan.instructionsPath,
      contentHash: plan.contentHash,
      injectionCount: 1,
      lastInjectionJson,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        agentInstructionInjections.companyId,
        agentInstructionInjections.issueId,
        agentInstructionInjections.agentId,
        agentInstructionInjections.adapterType,
        agentInstructionInjections.instructionsPath,
      ],
      set: {
        contentHash: plan.contentHash,
        injectionCount: plan.mode === "compact"
          ? sql`${agentInstructionInjections.injectionCount} + 1`
          : 1,
        lastInjectionJson,
        updatedAt: now,
      },
    });
  return true;
}
