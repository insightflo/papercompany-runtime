// server/src/services/self-improvement-adoption.ts
//
// [파일 목적] 자기개선 채택 라이브 오케스트레이터 — 미션 오너/운영자가 제출한
//   selfImprovementCandidates + 게이트 판정을 실제 회사 자산(company_skills)에 적용한다.
//   계층: 이 서비스(배선) → adoption-planner(순수 계획) → adoption-executor(순수 적용).
//   지식 위키 연결(Phase 2): evidenceSource의 knowledge_pattern 참조는 회사 카드 검색으로
//   레지스트리를 구성해 해석하고, 채택 적용 시 company_skills.metadata.impact 원장에 기록한다.
// [불변식]
//   - 회사 스코프 필수(규칙 1). 레지스트리·스토어·원장 전부 companyId로 닫힌다.
//   - 게이트 판정은 호출자가 구조화 배열로 제출(에이전트/피어 검증이 승인 기제 —
//     운영자를 승인 단계에 삽입하지 않는 정책). 자연어 파싱 없음(규칙 8).
//   - 기계적 콘텐츠 게이트: 유계 패치만 통과(frontmatter 불변 + 크기 상한 + 본문 비움 금지).
//   - 모든 적용·원장 기록은 activity_log로 남는다.
// [소비] routes/self-improvement-adoptions.ts (보드 + 회사 스코프 에이전트 키).

import { and, eq, inArray } from "drizzle-orm";
import { createHash } from "node:crypto";
import type { Db } from "@paperclipai/db";
import { activityLog, adoptionGateVerdicts, companySkills } from "@paperclipai/db";
import { unprocessable } from "../errors.js";
import { companySkillService, parseFrontmatterMarkdown } from "./company-skills.js";
import {
  knowledgePatternAdoptionRegistryEntries,
  knowledgePatternsService,
} from "./knowledge-patterns.js";
import {
  buildSelfImprovementAdoptionPlan,
  type AdoptionAssetRegistryEntry,
  type AdoptionGateVerdict,
  type BuildSelfImprovementAdoptionPlanResult,
  type SelfImprovementAdoptionPlannerDiagnostic,
  type SelfImprovementCandidate,
} from "./self-improvement-adoption-planner.js";
import {
  applySelfImprovementAdoptionPlan,
  type SelfImprovementAdoptionAppliedEntry,
  type SelfImprovementAdoptionExecutorDiagnostic,
} from "./self-improvement-adoption-executor.js";

const CANDIDATES_MAX = 50;
const GATE_VERDICTS_MAX = 100;
const PATTERN_REGISTRY_LIMIT = 200;
/** 유계 패치 크기 상한 — 한 번의 채택이 스킬을 8KB 이상 부풀리면 기계적 게이트 실패. */
const MAX_PATCH_GROWTH_CHARS = 8192;
/** 등록 판정 신선도 — 그보다 오래된 PASS는 재검 없이 재사용 불가. */
const VERDICT_FRESHNESS_MS = 7 * 24 * 60 * 60 * 1000;

export type AdoptionApplyActor = {
  type: "board" | "agent";
  agentId?: string | null;
};

/** 후보 패치의 정규 해시 — 판정 원장이 후보 내용에 묶이는 기준(키 순서 고정). */
export function adoptionCandidateHash(candidate: Record<string, unknown>): string {
  const proposedEdit = candidate && typeof candidate.proposedEdit === "object" && candidate.proposedEdit !== null && !Array.isArray(candidate.proposedEdit)
    ? candidate.proposedEdit as Record<string, unknown>
    : {};
  return createHash("sha256").update(JSON.stringify({
    assetType: candidate.assetType,
    assetRef: candidate.assetRef,
    operation: proposedEdit.operation,
    section: proposedEdit.section,
    content: proposedEdit.content ?? null,
  })).digest("hex");
}

export type SelfImprovementAdoptionApplyResult = {
  applied: SelfImprovementAdoptionAppliedEntry[];
  diagnostics: Array<SelfImprovementAdoptionPlannerDiagnostic | SelfImprovementAdoptionExecutorDiagnostic>;
};

function stableFrontmatter(markdown: string) {
  return JSON.stringify(parseFrontmatterMarkdown(markdown).frontmatter);
}

export function selfImprovementAdoptionService(db: Db) {
  const skillSvc = companySkillService(db);

  /** [판정 실체화] 피어/검증자가 후보 해시에 묶은 판정을 내구 원장에 기록한다. */
  async function recordGateVerdict(input: {
    companyId: string;
    gateOwner: unknown;
    candidateHash: unknown;
    verdict: unknown;
    note?: unknown;
    createdByAgentId: string | null;
  }): Promise<typeof adoptionGateVerdicts.$inferSelect> {
    const gateOwner = typeof input.gateOwner === "string" ? input.gateOwner.trim() : "";
    if (!gateOwner || gateOwner.length > 100) {
      throw unprocessable("gate verdict gateOwner must be a non-empty string (max 100 chars)");
    }
    const candidateHash = typeof input.candidateHash === "string" ? input.candidateHash.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(candidateHash)) {
      throw unprocessable("gate verdict candidateHash must be a 64-char hex sha256 (from dry-run)");
    }
    const verdict = String(input.verdict ?? "");
    if (!["PASS", "FAIL"].includes(verdict)) {
      throw unprocessable("gate verdict must be PASS or FAIL");
    }
    const note = typeof input.note === "string" && input.note.trim() ? input.note.trim().slice(0, 500) : null;

    const [row] = await db
      .insert(adoptionGateVerdicts)
      .values({
        companyId: input.companyId,
        gateOwner,
        candidateHash,
        verdict,
        ...(note ? { note } : {}),
        createdByAgentId: input.createdByAgentId,
      })
      .returning();

    await db.insert(activityLog).values({
      companyId: input.companyId,
      actorType: "system",
      actorId: input.createdByAgentId ?? "operator-adoption",
      action: "adoption_gate_verdict.recorded",
      entityType: "adoption_gate_verdict",
      entityId: row!.id,
      details: { gateOwner, candidateHash, verdict },
    });
    return row!;
  }

  /** 후보별 해시 계산 — dry-run/apply 양쪽이 같은 기준으로 쓴다. */
  function hashCandidates(candidates: SelfImprovementCandidate[]): string[] {
    return candidates.map((candidate) => adoptionCandidateHash(candidate as Record<string, unknown>));
  }

  /** [에이전트 경로] 판정 원장에서 후보별 PASS 해석 — 자기 인증 차단(제출자 ≠ 판정자) + 신선도. */
  async function resolveRegisteredVerdicts(input: {
    companyId: string;
    candidateHashes: string[];
    candidates: SelfImprovementCandidate[];
    submitterAgentId: string | null;
  }): Promise<AdoptionGateVerdict[]> {
    const cutoff = new Date(Date.now() - VERDICT_FRESHNESS_MS);
    const rows = input.candidateHashes.length > 0
      ? await db
        .select()
        .from(adoptionGateVerdicts)
        .where(and(
          eq(adoptionGateVerdicts.companyId, input.companyId),
          inArray(adoptionGateVerdicts.candidateHash, input.candidateHashes),
          eq(adoptionGateVerdicts.verdict, "PASS"),
        ))
      : [];
    const fresh = rows.filter((row) => row.createdAt >= cutoff);

    const verdicts: AdoptionGateVerdict[] = [];
    for (let index = 0; index < input.candidates.length; index += 1) {
      const candidate = input.candidates[index]!;
      const hash = input.candidateHashes[index]!;
      const gateOwner = typeof candidate.gateOwner === "string" ? candidate.gateOwner : "";
      const qualifies = fresh.some((row) =>
        row.candidateHash === hash
        && row.gateOwner === gateOwner
        && (row.createdByAgentId == null || row.createdByAgentId !== input.submitterAgentId));
      if (qualifies) verdicts.push({ gateOwner, verdict: "PASS", candidateHash: hash });
    }
    return verdicts;
  }

  /** 후보/판정 입력 형태 검증 — 계약 위반은 422로 실패 닫힘(무음 무시 금지). */
  function validateInputs(candidates: unknown, gateVerdicts: unknown): {
    candidates: SelfImprovementCandidate[];
    gateVerdicts: AdoptionGateVerdict[];
  } {
    if (!Array.isArray(candidates) || candidates.length === 0) {
      throw unprocessable("candidates must be a non-empty array");
    }
    if (candidates.length > CANDIDATES_MAX) {
      throw unprocessable(`candidates exceeds maximum of ${CANDIDATES_MAX}`);
    }
    if (!candidates.every((candidate) => candidate && typeof candidate === "object" && !Array.isArray(candidate))) {
      throw unprocessable("candidates entries must be objects");
    }
    if (!Array.isArray(gateVerdicts) || gateVerdicts.length === 0) {
      throw unprocessable("gateVerdicts must be a non-empty array");
    }
    if (gateVerdicts.length > GATE_VERDICTS_MAX) {
      throw unprocessable(`gateVerdicts exceeds maximum of ${GATE_VERDICTS_MAX}`);
    }
    const verdicts: AdoptionGateVerdict[] = [];
    for (const entry of gateVerdicts) {
      const owner = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).gateOwner
        : null;
      const verdictValue = entry && typeof entry === "object" && !Array.isArray(entry)
        ? (entry as Record<string, unknown>).verdict
        : null;
      if (typeof owner !== "string" || !owner.trim() || !["PASS", "FAIL"].includes(String(verdictValue))) {
        throw unprocessable("gateVerdicts entries require gateOwner and verdict PASS|FAIL");
      }
      verdicts.push({ gateOwner: owner, verdict: String(verdictValue) });
    }
    return { candidates: candidates as SelfImprovementCandidate[], gateVerdicts: verdicts };
  }

  /** 회사 자산 레지스트리: 스킬(key+slug) + 지식 위키 패턴 카드. 회사 스코프로만 구성. */
  async function buildAssetRegistry(companyId: string): Promise<AdoptionAssetRegistryEntry[]> {
    const [skills, patterns] = await Promise.all([
      skillSvc.listFull(companyId),
      knowledgePatternsService(db).search({ companyId, limit: PATTERN_REGISTRY_LIMIT }),
    ]);
    const skillEntries = skills.flatMap((skill) => {
      const byKey = { assetType: "skill", assetRef: skill.key, resolvedRef: skill.key };
      const slug = skill.slug?.trim();
      return slug && slug !== skill.key ? [byKey, { assetType: "skill", assetRef: slug, resolvedRef: skill.key }] : [byKey];
    });
    return [...skillEntries, ...knowledgePatternAdoptionRegistryEntries(patterns)];
  }

  /** DB 백킹 스킬 스토어 — resolvedRef는 스킬 key. 쓰기는 DB 마크다운만 갱신하고
   *   런타임 구체화(materializeRuntimeSkillFiles)가 다음 주입 주기에 반영한다. */
  function makeSkillAssetStore(companyId: string, writtenSkillIds: Map<string, string>) {
    return {
      readAsset: async (resolvedRef: string) => {
        const skill = await skillSvc.getByKey(companyId, resolvedRef);
        return skill ? skill.markdown : null;
      },
      writeAsset: async (resolvedRef: string, content: string) => {
        const skill = await skillSvc.getByKey(companyId, resolvedRef);
        if (!skill) throw new Error(`company skill ${resolvedRef} disappeared during adoption`);
        await db
          .update(companySkills)
          .set({ markdown: content, updatedAt: new Date() })
          .where(and(eq(companySkills.id, skill.id), eq(companySkills.companyId, companyId)));
        writtenSkillIds.set(resolvedRef, skill.id);
      },
    };
  }

  /** 기계적 콘텐츠 게이트 — 유계 패치 검증(실행 판정은 구조 조건만, 프로즈 해석 없음). */
  async function boundedMarkdownValidationRunner({ currentContent, patchedContent }: {
    currentContent: string;
    patchedContent: string;
  }): Promise<{ verdict: "PASS" | "FAIL"; reason?: string }> {
    if (!patchedContent.trim()) return { verdict: "FAIL", reason: "patched markdown is empty" };
    if (patchedContent.length > currentContent.length + MAX_PATCH_GROWTH_CHARS) {
      return { verdict: "FAIL", reason: `patch exceeds bounded growth of ${MAX_PATCH_GROWTH_CHARS} chars` };
    }
    if (stableFrontmatter(currentContent) !== stableFrontmatter(patchedContent)) {
      return { verdict: "FAIL", reason: "patch must not alter the skill frontmatter" };
    }
    if (!parseFrontmatterMarkdown(patchedContent).body.trim()) {
      return { verdict: "FAIL", reason: "patched markdown body is empty" };
    }
    return { verdict: "PASS" };
  }

  /** 지식 위키 패턴 근거 채택 → company_skills.metadata.impact 원장 기록. */
  function makeImpactRecorder(companyId: string) {
    return async ({ entry, validation }: {
      entry: { asset: { assetRef: string }; evidencePatternIds?: string[]; gateOwner: string; proposedEdit: { operation: string; section: string } };
      validation: { verdict: string };
    }) => {
      for (const patternId of entry.evidencePatternIds ?? []) {
        await skillSvc.recordAdoptionImpact(companyId, entry.asset.assetRef, {
          adoptedFrom: patternId,
          validation: {
            verdict: validation.verdict,
            gateOwner: entry.gateOwner,
            operation: entry.proposedEdit.operation,
            section: entry.proposedEdit.section,
          },
        });
      }
    };
  }

  return {
    /** 읽기 전용 드라이런 — 계획/진단/후보 해시(판정 원장용)만 반환한다. */
    async dryRun(input: { companyId: string; candidates: unknown; gateVerdicts?: unknown }): Promise<BuildSelfImprovementAdoptionPlanResult & { candidateHashes: string[] }> {
      const { candidates, gateVerdicts } = validateInputs(input.candidates, input.gateVerdicts ?? [{ gateOwner: "dry-run", verdict: "PASS" }]);
      const candidateHashes = hashCandidates(candidates);
      const assetRegistry = await buildAssetRegistry(input.companyId);
      const planned = buildSelfImprovementAdoptionPlan({ candidates, assetRegistry, gateVerdicts, candidateHashes });
      return { ...planned, candidateHashes };
    },

    /** 실제 적용 — 게이트 PASS + 유계 패치 통과만 스킬에 기록, 원장/활동로그 남긴다.
     *  판정 출처 분리(자기 인증 차단):
     *  - 보드: 운영자 권한으로 인라인 판정 허용(기존 계약).
     *  - 에이전트: 인라인 판정 거부 — 판정 원장의 해시 묶음 PASS만 인정(제출자≠판정자, 7일 신선도). */
    async apply(input: {
      companyId: string;
      candidates: unknown;
      gateVerdicts?: unknown;
      actor: AdoptionApplyActor;
    }): Promise<SelfImprovementAdoptionApplyResult & { candidateHashes: string[] }> {
      if (input.actor.type === "agent" && input.gateVerdicts != null) {
        throw unprocessable("agent callers must not inline gate verdicts; peers record verdicts via POST /self-improvement-adoptions/verdicts");
      }
      const actorId = input.actor.type === "agent" ? input.actor.agentId ?? "agent-adoption" : "operator-adoption";
      const { candidates } = validateInputs(input.candidates, input.actor.type === "board" ? input.gateVerdicts : [{ gateOwner: "registry", verdict: "PASS" }]);
      const candidateHashes = hashCandidates(candidates);

      let gateVerdicts: AdoptionGateVerdict[];
      if (input.actor.type === "agent") {
        gateVerdicts = await resolveRegisteredVerdicts({
          companyId: input.companyId,
          candidateHashes,
          candidates,
          submitterAgentId: input.actor.agentId ?? null,
        });
      } else {
        gateVerdicts = (Array.isArray(input.gateVerdicts) ? input.gateVerdicts : []) as AdoptionGateVerdict[];
      }

      const assetRegistry = await buildAssetRegistry(input.companyId);
      const planned = buildSelfImprovementAdoptionPlan({ candidates, assetRegistry, gateVerdicts, candidateHashes });

      const writtenSkillIds = new Map<string, string>();
      const executed = await applySelfImprovementAdoptionPlan({
        plan: planned.plan,
        assetStore: makeSkillAssetStore(input.companyId, writtenSkillIds),
        validationRunner: boundedMarkdownValidationRunner,
        impactRecorder: makeImpactRecorder(input.companyId),
      });

      for (const appliedEntry of executed.applied) {
        const skillId = writtenSkillIds.get(appliedEntry.resolvedRef);
        if (!skillId) continue;
        await db.insert(activityLog).values({
          companyId: input.companyId,
          actorType: "system",
          actorId,
          action: "company_skill.adoption_applied",
          entityType: "company_skill",
          entityId: skillId,
          details: {
            skillKey: appliedEntry.resolvedRef,
            operation: appliedEntry.operation,
            section: appliedEntry.section,
            gateOwner: planned.plan.find((entry) => entry.candidateIndex === appliedEntry.candidateIndex)?.gateOwner ?? null,
            adoptedFromPatternIds: appliedEntry.adoptedFromPatternIds,
          },
        });
      }

      return { applied: executed.applied, diagnostics: [...planned.diagnostics, ...executed.diagnostics], candidateHashes };
    },

    recordGateVerdict,
  };
}
