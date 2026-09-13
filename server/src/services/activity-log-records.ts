// server/src/services/activity-log-records.ts
//
// [purpose] T3 §2 정식 기록·감사 추출. 감사 행 insert 만 담당하는 DB 전용 기록 함수.
//   트랜잭션 안에서 쓸 수 있어야 하므로 live-event 발행·plugin bus 호출(커밋 전 이벤트 금지,
//   설계 §3.3)은 하지 않는다. 발행은 activity-log.ts logActivity 가 insert 이후에 수행한다.
// [authority] 감사 로그는 감사 자료이지 실행 권위가 아니다(AGENTS 규칙 9).

import type { Db } from "@paperclipai/db";
import { activityLog } from "@paperclipai/db";
import { redactCurrentUserValue } from "../log-redaction.js";
import { sanitizeRecord } from "../redaction.js";
import { instanceSettingsService } from "./instance-settings.js";
import type { LogActivityInput } from "./activity-log.js";

/** DB 전용 감사 행 insert. redaction 만 적용하고 이벤트를 발행하지 않는다. */
export async function insertActivityRecord(db: Db, input: LogActivityInput): Promise<void> {
  const currentUserRedactionOptions = {
    enabled: (await instanceSettingsService(db).getGeneral()).censorUsernameInLogs,
  };
  const sanitizedDetails = input.details ? sanitizeRecord(input.details) : null;
  const redactedDetails = sanitizedDetails
    ? redactCurrentUserValue(sanitizedDetails, currentUserRedactionOptions)
    : null;
  await db.insert(activityLog).values({
    companyId: input.companyId,
    actorType: input.actorType,
    actorId: input.actorId,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    agentId: input.agentId ?? null,
    runId: input.runId ?? null,
    details: redactedDetails,
  });
}
