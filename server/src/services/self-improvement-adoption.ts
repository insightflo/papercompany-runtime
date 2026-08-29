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

import { and, eq } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import { activityLog, companySkills } from "@paperclipai/db";
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

export type SelfImprovementAdoptionApplyResult = {
  applied: SelfImprovementAdoptionAppliedEntry[];
  diagnostics: Array<SelfImprovementAdoptionPlannerDiagnostic | SelfImprovementAdoptionExecutorDiagnostic>;
};

function stableFrontmatter(markdown: string) {
  return JSON.stringify(parseFrontmatterMarkdown(markdown).frontmatter);
}

export function selfImprovementAdoptionService(db: Db) {
  const skillSvc = companySkillService(db);

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
    /** 읽기 전용 드라이런 — 계획과 진단만 반환한다. */
    async dryRun(input: { companyId: string; candidates: unknown; gateVerdicts: unknown }): Promise<BuildSelfImprovementAdoptionPlanResult> {
      const { candidates, gateVerdicts } = validateInputs(input.candidates, input.gateVerdicts);
      const assetRegistry = await buildAssetRegistry(input.companyId);
      return buildSelfImprovementAdoptionPlan({ candidates, assetRegistry, gateVerdicts });
    },

    /** 실제 적용 — 게이트 PASS + 유계 패치 통과만 스킬에 기록, 원장/활동로그 남김. */
    async apply(input: {
      companyId: string;
      candidates: unknown;
      gateVerdicts: unknown;
      actorId: string;
    }): Promise<SelfImprovementAdoptionApplyResult> {
      const { candidates, gateVerdicts } = validateInputs(input.candidates, input.gateVerdicts);
      const assetRegistry = await buildAssetRegistry(input.companyId);
      const planned = buildSelfImprovementAdoptionPlan({ candidates, assetRegistry, gateVerdicts });

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
          actorId: input.actorId,
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

      return { applied: executed.applied, diagnostics: [...planned.diagnostics, ...executed.diagnostics] };
    },
  };
}
