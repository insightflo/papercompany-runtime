// packages/shared/src/validators/shutdown-checkpoint.ts
//
// [checkpoint+graceful shutdown] 종료 플러시 마킹에 첨부되는 체크포인트 "참조 레코드" 검증.
// 재개에 필요한 실 상태는 이미 각 내구 저장소에 흩어져 있다:
//   - 이슈 지시 소비 커서: issues.last_operator_instruction_at/_comment_id (#276)
//   - 효과 장부: effect_intents (attempt_run_id 로 런 소속 조회) (#279)
//   - 세션: heartbeat_runs.sessionIdBefore / contextSnapshot.sessionId
// 이 레코드는 복제가 아니라 "참조 모음"이다 — 마킹과 같은 CAS 쓰기에 원자적으로 첨부되며,
// 런타임은 이를 읽어 되돌리지 않는다(감사/재개 안내 전용). zod v1 strict: version 고정, unknown 키 거부.
import { z } from "zod";

const isoTimestamp = z.string().min(1);

export const shutdownCheckpointSchema = z
  .object({
    version: z.literal(1),
    // 서버가 종료 시점에 아는 실행 국면. 과욕 금지: 서버 측 사실만.
    phase: z.enum(["running_at_shutdown"]),
    cause: z.literal("graceful_shutdown"),
    signal: z.enum(["SIGINT", "SIGTERM"]),
    interruptedAt: isoTimestamp,
    lastPid: z.number().int().positive().nullable(),
    // 참조 1: 세션 연속성 (세션 회전/재개 토큰이 없으면 null — 없는 사실은 만들지 않는다).
    sessionId: z.string().min(1).nullable(),
    resumeToken: z.string().min(1).nullable(),
    // 참조 2: 이슈 지시 소비 커서 (#276 tuple cursor 스냅샷).
    issueInstructionCursor: z
      .object({
        commentId: z.string().min(1).nullable(),
        at: isoTimestamp.nullable(),
      })
      .strict()
      .nullable(),
    // 참조 3: 이 런이 발행한 효과 intent 키 목록 (#279 장부 — 상태 원본은 effect_intents 테이블).
    effectIntentIds: z.array(z.string().min(1)).max(50),
    // 마킹 직후 재시도가 대기열에 들어가는지(없으면 소진/에이전트 부재).
    retryPlanned: z.boolean(),
  })
  .strict();

export type ShutdownCheckpoint = z.infer<typeof shutdownCheckpointSchema>;
