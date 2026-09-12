// server/src/services/missions/plan-qa-applicability.ts
//
// [파일 목적] T7 추가 검사(addendum check) 적용 조건 판정. Applicability 는
//   'always' 또는 'selected_templates_all' 두 형식만 지원하며, 판정은 고정(pin)된
//   선택 집합에 대해서만 한다. 자연어 조건·정규식·임의 코드 분기는 없다.
// [주의] schema 수준의 빈/중복/UUID 검증은 @paperclipai/shared applicabilitySchema,
//   회사 허용 집합 밖 templateId 거부는 plan-qa-addendum-manifest pin 이 담당한다.
import type { Applicability } from "@paperclipai/shared";

export function applies(rule: Applicability, selected: readonly string[]): boolean {
  return rule.op === "always" || rule.templateIds.every((id) => selected.includes(id));
}
