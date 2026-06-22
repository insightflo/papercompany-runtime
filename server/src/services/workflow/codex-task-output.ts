/**
 * [파일 목적] codex CLI stdout(JSONL)에서 validation verdict 후보가 될 agent 메시지를 추출하는
 *   단일 공유 구현. heartbeat(extractRequestChangesVerdict) 와 dag-engine
 *   (readValidationVerdictFromHeartbeatResult) 이 같은 원천에서 판정을 읽도록 중복을 제거한다.
 *
 * [주요 흐름] stdout 을 줄 단위로 JSON 파싱 → type:"task_complete"(payload.last_agent_message) 또는
 *   type:"item.completed"(item.type:"agent_message" → item.text) 메시지 수집 → 역순(reverse) 반환.
 *   역순인 이유: codex 출력의 마지막 agent 메시지를 verdict 후보 최우선으로 두기 위해.
 *
 * [외부 연결] heartbeat.ts extractRequestChangesVerdict, dag-engine.ts readValidationVerdictFromHeartbeatResult.
 *
 * [수정시 주의] 이 함수는 verdict 추출의 단일 원천이다. 두 호출처가 동일 결과를 받으므로 issue auto-close
 *   validation gate(heartbeat)와 syncStepRunsFromIssueState / loop-driver predFacts(dag-engine)가
 *   엇갈리지 않는다. 반환 메시지는 downstream(readExplicitValidationVerdict)에서 다시 공백/기호 정규화하므로
 *   trim 여부 자체는 판정 결과에 영향을 주지 않는다. codex JSONL 스키마(type/payload.last_agent_message,
 *   item.completed/item.type/item.text)가 변경되면 여기서 함께 갱신해야 한다.
 */

/**
 * [목적] codex CLI stdout(JSONL)에서 task_complete / item.completed 이벤트의 agent 메시지 추출.
 * [입력] stdout: codex CLI stdout 전체 문자열 (null 또는 빈 문자열 허용).
 * [출력] non-empty 메시지 문자열 배열. codex 출력 순서의 역순(reverse).
 * [연결] heartbeat.ts extractRequestChangesVerdict, dag-engine.ts readValidationVerdictFromHeartbeatResult.
 * [주의] 단일 원천(DRY). 두 호출처가 공유하므로 여기만 바꾸면 양쪽이 같이 반영된다.
 */
export function extractCodexTaskCompleteMessages(stdout: string | null): string[] {
  if (!stdout) return [];
  const messages: string[] = [];
  for (const line of stdout.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const record = asRecord(parsed);
    if (record.type === "task_complete") {
      const message = asNonEmptyString(asRecord(record.payload).last_agent_message);
      if (message !== null) messages.push(message);
      continue;
    }
    if (record.type === "item.completed") {
      const item = asRecord(record.item);
      if (item.type === "agent_message") {
        const message = asNonEmptyString(item.text);
        if (message !== null) messages.push(message);
      }
    }
  }
  return messages.reverse();
}

/** [목적] unknown 값을 객체로 정규화. 배열/비객체는 빈 객체로 취급(dag-engine normalizeRecord와 동일). */
function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/** [목적] unknown 값을 non-empty 문자열로 변환. 공백만 있는 문자열/비문자열은 null (trim해서 반환). */
function asNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}
