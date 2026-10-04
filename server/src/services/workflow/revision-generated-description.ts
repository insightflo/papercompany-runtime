// server/src/services/workflow/revision-generated-description.ts
import { z } from "zod";
import { sha256Text } from "../issue-execution-cards/hash.js";
import type { WorkflowStep } from "./dag-engine.js";

/**
 * [생성 설명 계약] PAQO 생성 스텝의 description 은 표시용 미션 제목(`Mission: <title>` 줄)과
 * 실행 지시를 함께 담는다. 미션 제목은 실행 구성이 아니라 표시물이므로 생성 시점에 typed 입력
 * (missionTitle)으로만 주입하고, seed 비교는 결합된 버전 계약이 정당성을 증명할 때만 실행 의미
 * SHA(paqo.generated-description.v1)로 수행한다. 계약이 없거나(stale/missing) 깨지면
 * (tampered/malformed) 추측 복구 없이 원문 description 바이트 비교로 돌아간다(보수 거절 기본값).
 *
 * [권한 경계] 이 결합은 생성 데이터 정합성 검사일 뿐 생산자 인증/서명이 아니며 기존 승인·회사·
 * 고정본 전체 해시 검사를 대체하지 않는다. 문장·`Mission:` 패턴·헤딩을 읽어 의미를 추출하지
 * 않는다(규칙 8): typed 필드 재구성과 두 SHA 검증만 수행한다.
 */

export const GENERATED_DESCRIPTION_BINDING_VERSION = "paqo.generated-description.v1";

export interface GeneratedDescriptionBinding {
  schemaVersion: typeof GENERATED_DESCRIPTION_BINDING_VERSION;
  missionTitle: string;
  executionLines: string[];
  descriptionSha256: string;
  executionSha256: string;
}

export interface GeneratedStepDescription {
  description: string;
  revisionDescriptionBinding: GeneratedDescriptionBinding;
}

const lowercaseSha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "must be lowercase 64-hex sha256");

/** strict: 알 수 없는 키·버전·배열 형태·SHA 형태가 어긋나면 계약 전체를 기각한다. */
const generatedDescriptionBindingSchema = z.object({
  schemaVersion: z.literal(GENERATED_DESCRIPTION_BINDING_VERSION),
  missionTitle: z.string(),
  executionLines: z.array(z.string()),
  descriptionSha256: lowercaseSha256Schema,
  executionSha256: lowercaseSha256Schema,
}).strict();

/** 기존 `.filter(Boolean)` 과 동일하게 null/undefined/빈 문자열 실행 줄만 제외한다. */
function compactExecutionLines(executionLines: readonly (string | null)[]): string[] {
  return executionLines.filter((line): line is string => typeof line === "string" && line !== "");
}

/** 표시 설명: 첫 실행 줄 뒤에 `Mission: <title>` 줄을 삽입하는 레거시 바이트 형식 그대로. */
function renderDisplayDescription(missionTitle: string, executionLines: readonly string[]): string {
  return [executionLines[0], `Mission: ${missionTitle}`, ...executionLines.slice(1)].join("\n");
}

/**
 * PAQO 생성 스텝의 description + 결합 계약을 만든다. 실행 줄에는 기존 헤더·담당자/구조 게이트
 * 문구·스킬·reason·instructions·outcomeContractLines·sourceRef 를 전부 보존하고, 제외되는 것은
 * 별도 인수로 받은 missionTitle 뿐이다(문자열 필터링/파싱 아님). 생성기는 항상 자기 계약을 만든다.
 */
export function buildPaqoStepDescription(missionTitle: string, executionLines: readonly (string | null)[]): GeneratedStepDescription {
  const lines = compactExecutionLines(executionLines);
  const description = renderDisplayDescription(missionTitle, lines);
  return {
    description,
    revisionDescriptionBinding: {
      schemaVersion: GENERATED_DESCRIPTION_BINDING_VERSION,
      missionTitle,
      executionLines: lines,
      descriptionSha256: sha256Text(description),
      executionSha256: sha256Text(lines.join("\n")),
    },
  };
}

type StepWithGeneratedDescriptionBinding = WorkflowStep & { revisionDescriptionBinding?: unknown };

/**
 * 실행 의미 SHA 를 읽되 다음을 모두 통과할 때만 반환한다(하나라도 어긋나면 null):
 *   1) description 이 문자열이고 결합이 strict 스키마와 정확히 일치한다.
 *   2) 저장된 typed 필드(missionTitle/executionLines)로 재구성한 표시 설명이 현재 description
 *      전체와 정확히 같은 바이트다(stale/재발급 누락 거절).
 *   3) descriptionSha256 이 현재 전체 description 원문 바이트의 SHA다.
 *   4) executionSha256 이 executionLines.join("\n") 원문 바이트의 SHA다.
 * SHA 필드가 존재한다는 이유만으로 신뢰하지 않는다. null 이면 호출자는 원문 비교로 돌아간다.
 */
export function readGeneratedExecutionDescriptionSha(step: StepWithGeneratedDescriptionBinding): string | null {
  if (typeof step.description !== "string") return null;
  const parsed = generatedDescriptionBindingSchema.safeParse(step.revisionDescriptionBinding);
  if (!parsed.success) return null;
  const binding = parsed.data;
  if (binding.executionLines.length === 0) return null;
  if (renderDisplayDescription(binding.missionTitle, binding.executionLines) !== step.description) return null;
  if (binding.descriptionSha256 !== sha256Text(step.description)) return null;
  if (binding.executionSha256 !== sha256Text(binding.executionLines.join("\n"))) return null;
  return binding.executionSha256;
}
