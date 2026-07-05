// [파일 목적] mission_issue_handoffs 의 goal/summary 텍스트 길이를 제한.
//   source issue description 전체가 handoff_markdown/handoff_json 으로 복사되는 것을 막는다.
// [주요 흐름] trim + cap 초과분은 말줄임표.
// [외부 연결] mission-runtime-manager.ts(buildMissionIssueHandoffMarkdown), issue-terminal-handoff.ts.
// [수정시 영향] cap 을 올리면 handoff 가 길어져 runtime brief 가 커진다. 낮추면 정보 손실.
//   ponytail: 단순 slice. 향후 문단 단위 잘림이 필요하면 여기만 고친다.

export const HANDOFF_TEXT_CAP = 600;

export function truncateHandoffText(
  value: string | null | undefined,
  cap: number = HANDOFF_TEXT_CAP,
): string {
  const text = (value ?? "").trim();
  if (text.length <= cap) return text;
  return `${text.slice(0, cap - 1).trimEnd()}…`;
}
