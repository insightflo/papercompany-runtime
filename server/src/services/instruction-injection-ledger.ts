import path from "node:path";
import { and, eq, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agentInstructionInjections, issueExecutionCards } from "@paperclipai/db";
import { loadInstructionsWithInlinedReferences } from "@paperclipai/adapter-utils/instructions";
import { hashStructuredValue } from "./issue-execution-cards/hash.js";
import { parseObject } from "../adapters/utils.js";

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

export async function applyInstructionInjectionLedger(input: {
  db: Db;
  context: Record<string, unknown>;
  agent: { id: string; companyId: string; adapterType: string };
  issueId: string | null;
  adapterConfig: Record<string, unknown>;
  cwd: string;
}) {
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
    contentHash: hashStructuredValue({
      content: loaded.content,
      includedPaths: loaded.includedPaths,
      deferredPaths: loaded.deferredPaths,
    }),
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
  const compact = previous?.contentHash === injectionJson.contentHash;
  const now = new Date();
  await input.db
    .insert(agentInstructionInjections)
    .values({
      companyId: input.agent.companyId,
      issueId: input.issueId,
      agentId: input.agent.id,
      adapterType: input.agent.adapterType,
      instructionsPath,
      contentHash: injectionJson.contentHash,
      injectionCount: 1,
      lastInjectionJson: injectionJson,
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
        contentHash: injectionJson.contentHash,
        injectionCount: compact
          ? sql`${agentInstructionInjections.injectionCount} + 1`
          : 1,
        lastInjectionJson: injectionJson,
        updatedAt: now,
      },
    });

  input.context.paperclipInstructionInjection = {
    mode: compact ? "compact" : "full",
    entryPath: loaded.entryPath,
    contentHash: injectionJson.contentHash,
    includedPaths: loaded.includedPaths,
    deferredPaths: loaded.deferredPaths,
  };
  return parseObject(input.context.paperclipInstructionInjection);
}
