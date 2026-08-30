// ui/src/lib/missionRevisionRequest.ts
//
// [목적] 미션 상세 화면의 "수정 요청" 버튼이 생성할 신규 미션의 사전 채움 값 계산(순수 함수).
//   원본 미션 링크 + 최근 완료 런의 산출물 URL(최대 5) + 수정 지시 칸을 description에 담아,
//   운영자가 "New Mission에 URL 붙여넣기"로 하던 작업을 한 번의 클릭으로 대체한다.
// [계약] 반환값은 NewMissionDialog의 NewMissionDefaults와 같은 모양.

import type { MissionWorkflowRun } from "../api/missions";

export interface MissionRevisionPrefillInput {
  mission: { id: string; title: string; ownerAgentId: string };
  workflowRuns: MissionWorkflowRun[];
  origin: string;
  issuePrefix?: string | null;
}

export function buildMissionRevisionPrefill(input: MissionRevisionPrefillInput): {
  title: string;
  description: string;
  ownerAgentId: string;
} {
  const artifactUrls = input.workflowRuns
    .filter((run) => run.status === "completed")
    .flatMap((run) => run.steps.flatMap((step) => step.workProducts ?? []))
    .filter((product) => product.url)
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
    .slice(0, 5);

  const missionUrl = input.issuePrefix
    ? `${input.origin}/${input.issuePrefix}/missions/${input.mission.id}`
    : input.mission.id;

  const lines = [
    "[수정 요청] 아래 원본 미션의 결과물을 수정합니다.",
    "",
    `원본 미션: ${input.mission.title}`,
    `원본 미션 링크: ${missionUrl}`,
  ];
  if (artifactUrls.length > 0) {
    lines.push("", "원본 최종 산출물:");
    for (const product of artifactUrls) lines.push(`- ${product.url} (${product.title})`);
  }
  lines.push(
    "",
    "수정 지시:",
    "(무엇을 어떻게 수정할지 작성 — 예: 기존 승인 양식/템플릿을 사용해 재작성)",
  );

  return {
    title: `수정 요청 — ${input.mission.title}`,
    description: lines.join("\n"),
    ownerAgentId: input.mission.ownerAgentId,
  };
}
