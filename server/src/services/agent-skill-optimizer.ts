// server/src/services/agent-skill-optimizer.ts
//
// [파일 목적] Agent Wiki Phase 3 — SkillOpt-Sleep 자가진화 루프. 반복 실패(frequency≥threshold)를
//   agent 의 영구 promptTemplate 에 bounded-edit(마커 쌍)로 넣고, 관찰창 후 실패 추이로 수락/기각한다.
//   createNativeWorkflowReconciler 패턴(setInterval + tickInFlight + unref + per-tick try/catch)을 그대로 따른다.
//
// [주요 흐름] runWikiEvolutionPass(db, opts):
//   1) 후보 수집(active, frequency≥threshold, 미처리 entry) → agent promptTemplate 에 마커 블록 append +
//      proposal(proposing) 생성 + baseline frequency 기록.
//   2) 관찰창 경과 proposal → entry.frequency 가 baseline 대비 증가했으면 기각(revert: 마커 블록 제거),
//      유지/감소면 수락(블록 유지 + entry → resolved).
//
// [외부 연결] app.ts 가 env 게이트(AGENT_WIKI_EVOLUTION_ENABLED, default off)로 createAgentWikiEvolutionLoop
//   등록. 영구 쓰기는 agentService(db).update({adapterConfig}, {recordRevision}) 로 → config revision +
//   snapshot 자동 기록(감사/롤백 내장).
//
// [수정시 영향] v1 제약: managed-bundle(AGENTS.md 디스크) 에이전트는 SKIP(file IO 는 v2). legacy
//   promptTemplate(jsonb) 에이전트만 진화. entry 당 proposal 1개(unique entry_id) — v1 은 재제안 안 함.
//   마커 블록은 <!-- paperclip-skill-lesson:{entryId} START/END --> 쌍(idempotent append, surgical remove).
//   진화가 활성화 전(AGENT_WIKI_EVOLUTION_ENABLED off)이면 app.ts 가 loop 자체를 생성하지 않아 완전 inert.

import { and, desc, eq, gte } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { agents, agentWikiEntries, agentWikiEditProposals } from "@paperclipai/db";
import { logger as defaultLogger } from "../middleware/logger.js";
import { agentService } from "./agents.js";

// ---------------------------------------------------------------------------
// env 게이트 — resolveWorkflowSchedulerOwnership(scheduler-ownership.ts) 미러. default OFF.
// ---------------------------------------------------------------------------

export interface AgentWikiEvolutionOwnership {
  enabled: boolean;
}

function isEnabled(value: string | undefined): boolean {
  return value === "1" || value?.toLowerCase() === "true";
}

/**
 * [목적] AGENT_WIKI_EVOLUTION_ENABLED env 로 자가진화 루프 활성화 여부 결정.
 * [출력] { enabled }. undefined/그 외 → false(실험적 기능, 명시적 opt-in 필요).
 */
export function resolveAgentWikiEvolutionOwnership(
  env: Record<string, string | undefined> = process.env,
): AgentWikiEvolutionOwnership {
  return { enabled: isEnabled(env.AGENT_WIKI_EVOLUTION_ENABLED) };
}

// ---------------------------------------------------------------------------
// bounded-edit string helpers — 마커 쌍으로 idempotent append / surgical remove.
// (마커 관례: server/src/ui-branding.ts 의 <!-- PAPERCLIP_FAVICON_START/END --> 와 동일 방식)
// ---------------------------------------------------------------------------

const LESSON_MARKER = "paperclip-skill-lesson";

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockRegex(lessonId: string): RegExp {
  const id = escapeRegex(lessonId);
  return new RegExp(
    `\\n*<!-- ${LESSON_MARKER}:${id} START -->[\\s\\S]*?<!-- ${LESSON_MARKER}:${id} END -->\\n*`,
    "g",
  );
}

function lessonBody(pattern: string, solution: string): string {
  return [
    "## 주의 (자가진화 반영 — 같은 실수 방지)",
    `실패 패턴: ${pattern}`,
    `대응 가이드: ${solution}`,
  ].join("\n");
}

export function buildLessonBlock(lessonId: string, pattern: string, solution: string): string {
  return `<!-- ${LESSON_MARKER}:${lessonId} START -->\n${lessonBody(pattern, solution)}\n<!-- ${LESSON_MARKER}:${lessonId} END -->`;
}

/**
 * [목적] appendLessonBlock — prompt 에 마커 블록을 append(또는 같은 lessonId 면 본문 갱신).
 * [출력] 새 prompt 문자열. 기존 블록이 있으면 제거 후 재삽입(idempotent, 본문 최신화).
 */
export function appendLessonBlock(prompt: string, lessonId: string, pattern: string, solution: string): string {
  const stripped = prompt.replace(blockRegex(lessonId), "");
  return `${stripped.replace(/\n+$/, "")}\n\n${buildLessonBlock(lessonId, pattern, solution)}\n`;
}

/**
 * [목적] removeLessonBlock — prompt 에서 해당 lessonId 마커 블록만 surgically 제거(revert).
 * [출력] 블록 제거된 prompt 문자열.
 */
export function removeLessonBlock(prompt: string, lessonId: string): string {
  return prompt.replace(blockRegex(lessonId), "").replace(/\n{3,}/g, "\n\n").trim();
}

export function hasLessonBlock(prompt: string, lessonId: string): boolean {
  return new RegExp(`<!-- ${LESSON_MARKER}:${escapeRegex(lessonId)} START -->`).test(prompt);
}

// ---------------------------------------------------------------------------
// agent promptTemplate 접근 — v1: legacy inline promptTemplate(jsonb)만. managed-bundle 은 skip.
// ---------------------------------------------------------------------------

/**
 * [목적] readLegacyPromptTemplate — adapter_config 에서 inline promptTemplate 문자열 반환.
 *   managed-bundle(instructionsBundleMode=managed + root, 또는 instructionsFilePath) 에이전트는
 *   v1 에서 skip 하기 위해 null 반환(런타임이 디스크 AGENTS.md 를 읽으므로 jsonb 쓰기가 무의미/충돌).
 * [출력] promptTemplate 문자열(빈 문자열 불가), 또는 null(skip 대상).
 */

function readLegacyPromptTemplate(adapterConfig: Record<string, unknown> | null): string | null {
  const cfg = adapterConfig ?? {};
  const managedBundle =
    cfg.instructionsBundleMode === "managed" &&
    typeof cfg.instructionsRootPath === "string" &&
    cfg.instructionsRootPath.trim().length > 0;
  const hasInstructionsFile =
    typeof cfg.instructionsFilePath === "string" && cfg.instructionsFilePath.trim().length > 0;
  if (managedBundle || hasInstructionsFile) return null;
  const promptTemplate = cfg.promptTemplate;
  return typeof promptTemplate === "string" && promptTemplate.trim().length > 0 ? promptTemplate : null;
}

// ---------------------------------------------------------------------------
// runWikiEvolutionPass — 실제 진화 로직(루프에서 주기 호출 + 단위 테스트에서 직접 호출).
// ---------------------------------------------------------------------------

export interface RunWikiEvolutionPassOptions {
  frequencyThreshold?: number;
  observationWindowMs?: number;
  maxCandidates?: number;
  now?: Date;
  dryRun?: boolean;
}

export interface WikiEvolutionPassResult {
  proposed: number;
  accepted: number;
  rejected: number;
  skipped: number;
}

const DEFAULT_FREQUENCY_THRESHOLD = 5;
const DEFAULT_OBSERVATION_WINDOW_MS = 24 * 60 * 60_000; // 24h
const DEFAULT_MAX_CANDIDATES = 10;

/**
 * [목적] runWikiEvolutionPass — 한 번의 진화 패스. (1) 신규 후보에 bounded-edit 적용 + proposal 생성,
 *   (2) 관찰창 경과 proposal 을 실패 추이로 수락/기각.
 * [입력] db, opts(threshold/observationWindow/maxCandidates/now/dryRun). now 는 테스트 주입용.
 * [출력] { proposed, accepted, rejected, skipped }.
 * [주의] 영구 쓰기는 agentService.update + recordRevision. dryRun 시 DB/prompt 변경 없이 카운트만.
 * [수정시 영향] 후보 필터/수락기준 변경은 진화 품질에 직결. v1: entry 당 proposal 1개(unique entry_id).
 */
export async function runWikiEvolutionPass(
  db: Db,
  options?: RunWikiEvolutionPassOptions,
): Promise<WikiEvolutionPassResult> {
  const threshold = options?.frequencyThreshold ?? DEFAULT_FREQUENCY_THRESHOLD;
  const observationWindowMs = options?.observationWindowMs ?? DEFAULT_OBSERVATION_WINDOW_MS;
  const maxCandidates = options?.maxCandidates ?? DEFAULT_MAX_CANDIDATES;
  const now = options?.now ?? new Date();
  const dryRun = options?.dryRun ?? false;
  const agtSvc = agentService(db);
  const result: WikiEvolutionPassResult = { proposed: 0, accepted: 0, rejected: 0, skipped: 0 };

  // (1) 신규 후보: active + frequency>=threshold. entry 당 proposal unique → 기존 proposal 있으면 skip(v1).
  const candidates = await db
    .select()
    .from(agentWikiEntries)
    .where(and(eq(agentWikiEntries.status, "active"), gte(agentWikiEntries.frequency, threshold)))
    .orderBy(desc(agentWikiEntries.frequency))
    .limit(maxCandidates);

  for (const entry of candidates) {
    const existingProposal = await db
      .select({ id: agentWikiEditProposals.id, status: agentWikiEditProposals.status })
      .from(agentWikiEditProposals)
      .where(eq(agentWikiEditProposals.entryId, entry.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
    if (existingProposal) {
      // v1: entry 당 1 lifecycle. accepted/proposing/rejected 모두 재처리 안 함.
      result.skipped += 1;
      continue;
    }

    const [agentRow] = await db
      .select({
        id: agents.id,
        companyId: agents.companyId,
        adapterConfig: agents.adapterConfig,
      })
      .from(agents)
      .where(eq(agents.id, entry.agentId))
      .limit(1);
    if (!agentRow) {
      result.skipped += 1;
      continue;
    }

    const currentPrompt = readLegacyPromptTemplate(agentRow.adapterConfig);
    if (currentPrompt === null) {
      // managed-bundle 이거나 inline prompt 없음 → v1 skip(file IO 는 v2).
      result.skipped += 1;
      continue;
    }

    if (!dryRun) {
      const nextPrompt = hasLessonBlock(currentPrompt, entry.id)
        ? currentPrompt
        : appendLessonBlock(currentPrompt, entry.id, entry.pattern, entry.solution);
      const baseConfig = (agentRow.adapterConfig as Record<string, unknown> | null) ?? {};
      const nextConfig = { ...baseConfig, promptTemplate: nextPrompt };
      await agtSvc.update(
        agentRow.id,
        { adapterConfig: nextConfig },
        { recordRevision: { source: "skill_optimizer_lesson" } },
      );
      await db
        .insert(agentWikiEditProposals)
        .values({
          entryId: entry.id,
          agentId: entry.agentId,
          companyId: agentRow.companyId,
          pattern: entry.pattern,
          status: "proposing",
          baselineFrequency: entry.frequency,
          originalSnapshot: currentPrompt,
          proposedAt: now,
        })
        .onConflictDoNothing({ target: [agentWikiEditProposals.entryId] });
    }
    result.proposed += 1;
  }

  // (2) 관찰창 경과 proposal 결정: frequency 증가 → 기각(revert), 유지/감소 → 수락.
  const proposing = await db
    .select()
    .from(agentWikiEditProposals)
    .where(eq(agentWikiEditProposals.status, "proposing"))
    .limit(maxCandidates);

  for (const proposal of proposing) {
    const proposedAt = proposal.proposedAt ? new Date(proposal.proposedAt) : null;
    const ageMs = proposedAt ? now.getTime() - proposedAt.getTime() : Infinity;
    if (ageMs < observationWindowMs) continue; // 아직 관찰 중

    const [entry] = await db
      .select()
      .from(agentWikiEntries)
      .where(eq(agentWikiEntries.id, proposal.entryId))
      .limit(1)
      .then((rows) => [rows[0] ?? null]);

    const gotWorse = entry ? entry.frequency > proposal.baselineFrequency : false;

    if (gotWorse) {
      // 기각: 마커 블록 surgically 제거(revert).
      if (!dryRun) {
        const [agentRow] = await db
          .select({ id: agents.id, adapterConfig: agents.adapterConfig })
          .from(agents)
          .where(eq(agents.id, proposal.agentId))
          .limit(1);
        const livePrompt = readLegacyPromptTemplate(agentRow?.adapterConfig ?? null);
        const reverted = removeLessonBlock(
          hasLessonBlock(livePrompt ?? "", proposal.entryId)
            ? (livePrompt as string)
            : (proposal.originalSnapshot ?? ""),
          proposal.entryId,
        );
        if (agentRow) {
          const baseConfig = (agentRow.adapterConfig as Record<string, unknown> | null) ?? {};
          await agtSvc.update(
            agentRow.id,
            { adapterConfig: { ...baseConfig, promptTemplate: reverted } },
            { recordRevision: { source: "skill_optimizer_lesson_revert" } },
          );
        }
        await db
          .update(agentWikiEditProposals)
          .set({ status: "rejected", decidedAt: now, updatedAt: now })
          .where(eq(agentWikiEditProposals.id, proposal.id));
      }
      result.rejected += 1;
    } else {
      // 수락: 블록 유지, entry → resolved(재발 시 recordFailure 가 다시 active 로 되돌림).
      if (!dryRun) {
        await db
          .update(agentWikiEntries)
          .set({ status: "resolved", resolvedAt: now, updatedAt: now })
          .where(eq(agentWikiEntries.id, proposal.entryId));
        await db
          .update(agentWikiEditProposals)
          .set({ status: "accepted", decidedAt: now, updatedAt: now })
          .where(eq(agentWikiEditProposals.id, proposal.id));
      }
      result.accepted += 1;
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// createAgentWikiEvolutionLoop — reconciler/scheduler 패턴의 주기 루프 팩터리.
// ---------------------------------------------------------------------------

const DEFAULT_WIKI_EVOLUTION_INTERVAL_MS = 10 * 60_000; // 10분

export interface AgentWikiEvolutionLoopState {
  running: boolean;
  tickCount: number;
  lastTickAt: string | null;
  lastResult: WikiEvolutionPassResult | null;
  lastError: string | null;
}

export interface AgentWikiEvolutionLoop {
  start: () => void;
  stop: () => void;
  evolve: (now?: Date) => Promise<void>;
  getState: () => AgentWikiEvolutionLoopState;
}

export interface CreateAgentWikiEvolutionLoopOptions {
  db: Db;
  intervalMs?: number;
  passOptions?: RunWikiEvolutionPassOptions;
  runEvolutionPass?: (db: Db, options?: RunWikiEvolutionPassOptions) => Promise<WikiEvolutionPassResult>;
}

/**
 * [목적] createAgentWikiEvolutionLoop — wiki 자가진화 주기 루프. setInterval + tickInFlight 가드 +
 *   unref + per-tick try/catch(루퍼 불사). createNativeWorkflowReconciler 와 동일 구조.
 * [입력] { db, intervalMs?(기본 10분), passOptions?, runEvolutionPass?(주입용, 기본 runWikiEvolutionPass) }.
 * [출력] { start, stop, evolve, getState }. start 는 즉시 1회 evolve 후 interval arm(idempotent).
 * [주의] AGENT_WIKI_EVOLUTION_ENABLED off 시 app.ts 가 이 팩터리를 호출하지 않아 완전 inert.
 * [수정시 영향] intervalMs 변경은 진화 빈도/비용에 직결.
 */
export function createAgentWikiEvolutionLoop(
  options: CreateAgentWikiEvolutionLoopOptions,
): AgentWikiEvolutionLoop {
  const intervalMs = options.intervalMs ?? DEFAULT_WIKI_EVOLUTION_INTERVAL_MS;
  const runEvolutionPass = options.runEvolutionPass ?? runWikiEvolutionPass;
  const passOptions = options.passOptions ?? {};
  const log = defaultLogger;

  let interval: ReturnType<typeof setInterval> | null = null;
  let tickInFlight = false;
  let tickCount = 0;
  let lastTickAt: string | null = null;
  let lastResult: WikiEvolutionPassResult | null = null;
  let lastError: string | null = null;

  async function evolve(now = new Date()): Promise<void> {
    if (tickInFlight) {
      log.warn({ intervalMs }, "Agent wiki evolution tick skipped — previous tick still running");
      return;
    }
    tickInFlight = true;
    try {
      const passResult = await runEvolutionPass(options.db, { ...passOptions, now });
      tickCount += 1;
      lastTickAt = now.toISOString();
      lastResult = passResult;
      lastError = null;
      if (passResult.proposed > 0 || passResult.accepted > 0 || passResult.rejected > 0) {
        log.info({ intervalMs, ...passResult }, "Agent wiki evolution pass completed");
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      log.error({ intervalMs, err: lastError }, "Agent wiki evolution tick failed");
    } finally {
      tickInFlight = false;
    }
  }

  return {
    start() {
      if (interval) return;
      log.info({ intervalMs }, "Agent wiki evolution loop started");
      void evolve();
      interval = setInterval(() => {
        void evolve();
      }, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (!interval) return;
      clearInterval(interval);
      interval = null;
      log.info({ intervalMs }, "Agent wiki evolution loop stopped");
    },
    evolve,
    getState() {
      return { running: interval !== null, tickCount, lastTickAt, lastResult, lastError };
    },
  };
}
