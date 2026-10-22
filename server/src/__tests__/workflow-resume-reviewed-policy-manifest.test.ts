import { describe, expect, it } from "vitest";
import { REVIEWED_RESUME_POLICIES } from "../services/workflow/resume/reviewed-policy.js";

/**
 * [purpose] 실제 REVIEWED_RESUME_POLICIES 매니페스트(비 mock)의 구조 자기검증. 사람 검토로
 *   삽입된 엔트리가 preview-policy 해석기의 계약(schemaVersion 1, effect 어휘, binding 형식,
 *   게이트/게시/생성 id ⊆ steps)를 지키는지 순수 단위로 검증한다. DB registry 행 대조는
 *   bindingResolves(결합 테스트)의 책임이고 여기서는 하지 않는다.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const EFFECTS: ReadonlySet<string> = new Set(["none", "read_only", "external"]);

describe("REVIEWED_RESUME_POLICIES — 실제 매니페스트 구조 자기검증", () => {
  it("(companyId, definitionHash) 조합이 유일하다", () => {
    const keys = REVIEWED_RESUME_POLICIES.map((policy) => `${policy.companyId}:${policy.definitionHash}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("모든 엔트리가 schema 1 계약을 지킨다", () => {
    expect(REVIEWED_RESUME_POLICIES.length).toBeGreaterThan(0);
    for (const policy of REVIEWED_RESUME_POLICIES) {
      expect(policy.schemaVersion).toBe(1);
      expect(policy.companyId).toMatch(UUID_RE);
      expect(policy.definitionHash).toMatch(SHA256_RE);
      const stepIds = Object.keys(policy.steps);
      expect(stepIds.length).toBeGreaterThan(0);
      for (const step of Object.values(policy.steps)) {
        expect(EFFECTS.has(step.effect)).toBe(true);
        expect(Array.isArray(step.toolBindings)).toBe(true);
        for (const binding of step.toolBindings) {
          expect(binding.id).toMatch(UUID_RE);
          // bindingResolves 는 row.updatedAt.toISOString() 과 문자열 일치를 비교하므로
          // 바인딩 문자열은 정확히 toISOString 형식(ms 포함 UTC)이어야 한다.
          expect(() => new Date(binding.updatedAt).toISOString()).not.toThrow();
          expect(new Date(binding.updatedAt).toISOString()).toBe(binding.updatedAt);
          expect(binding.configHash).toMatch(SHA256_RE);
        }
      }
      const lists: Array<[string, string[]]> = [
        ["requiredGateStepIds", policy.requiredGateStepIds],
        ["publicationStepIds", policy.publicationStepIds],
        ["generationStepIds", policy.generationStepIds],
      ];
      for (const [label, ids] of lists) {
        for (const id of ids) {
          expect(stepIds).toContain(id);
        }
        expect(new Set(ids).size, `${label} 중복 금지`).toBe(ids.length);
      }
    }
  });

  it("youtube-report 정책(ff3e3efd)은 게이트·게시·생성 매핑을 선언한다", () => {
    const policy = REVIEWED_RESUME_POLICIES.find(
      (candidate) => candidate.companyId === "ff3e3efd-e30c-45c2-b893-497164405629",
    );
    expect(policy).toBeDefined();
    // 발행 스텝은 external 로 선언되고 publication 매핑에 있어야 한다.
    expect(policy!.steps["publish-onboarding-manual"]?.effect).toBe("external");
    expect(policy!.publicationStepIds).toContain("publish-onboarding-manual");
    // 발행 직전 기계 QA 게이트는 required gate 로 등록되어 재개 우회를 금지한다.
    expect(policy!.requiredGateStepIds).toContain("qa-youtube-report-content");
  });
});
