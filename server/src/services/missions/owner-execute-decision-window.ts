// server/src/services/missions/owner-execute-decision-window.ts
//
// [목적] mission_owner_execute 오퍼레이션을 오너 결정 API 창구(POST /issues/:id/owner-recovery/execute)로
//   제출받는 어댑터. 오너액션 이슈 웨이크 런에는 스텝이 없어 런 도구 계약이 만들어지지 않고 플러그인
//   도구 라우트가 403 으로 원천 거부됐다(2026-10-17 사고) — 이 창구는 같은 owner-recovery 인가 체인으로
//   기존 executeMissionOwnerAction 을 직접 호출해 8개 오퍼레이션 전부를 같은 검증·펜스·원장으로 실행한다.
// [권한] 결정 API 와 동일한 비-결정 체인(authorizeOwnerRecoveryWindow) — 미션 오너 일치 + unblock
//   owner-action 이슈 + 소스 이슈 동일 미션 + heartbeat identity + 체크아웃. 창구 인가는 짧은
//   트랜잭션으로 통제점만 제공하고, 실행 자체는 기존 서비스의 자체 검증(authenticate·펜스·커플링)이
//   그대로 적용된다(새 권한 경로가 아니다).
// [불변] 플러그인 도구 라우트·보드 경로 무변경. ownerActionIssueId 는 경로 파라미터가 공급한다.
import type { Db } from "@paperclipai/db";
import { missionOwnerExecuteSchema, ownerExecuteApiSchema, type OwnerExecuteApi } from "@paperclipai/shared/validators/mission-owner-authority";
import { HttpError } from "../../errors.js";
import { executeMissionOwnerAction, OwnerActionRefusalError, type OwnerActionResult } from "./mission-owner-execute.js";
import { authorizeOwnerRecoveryWindow } from "./owner-recovery-window-auth.js";
import type { OwnerRecoveryApiActor } from "./mission-owner-recovery-agent-api.js";

export type OwnerExecuteWindowResult = { readonly issueId: string; readonly result: OwnerActionResult };

export async function ownerExecuteDecisionWindow(db: Db, input: {
  readonly issueId: string;
  readonly actor: OwnerRecoveryApiActor;
  readonly request: OwnerExecuteApi;
}): Promise<OwnerExecuteWindowResult> {
  const body = ownerExecuteApiSchema.parse(input.request);
  // 창구 인가(결정 API 와 동일 체인)는 잠금이 유효한 짧은 트랜잭션 안에서만 수행한다.
  const { issue } = await db.transaction(async (tx) =>
    authorizeOwnerRecoveryWindow(tx as unknown as Db, input.issueId, input.actor, "execute"));
  // ownerActionIssueId 는 경로가 공급한다(본문 제공은 스키마에서 이미 거부). 미션 불일치·자격·
  // 펜스·멱등 검증은 기존 mission_owner_execute 서비스가 그대로 수행한다.
  const request = missionOwnerExecuteSchema.parse({ ...body, ownerActionIssueId: issue.id });
  try {
    const result = await executeMissionOwnerAction({ db, companyId: issue.companyId,
      agentId: input.actor.agentId!, heartbeatRunId: input.actor.runId! }, request);
    return { issueId: issue.id, result };
  } catch (error) {
    if (error instanceof OwnerActionRefusalError) throw new HttpError(error.status, error.reasonCode);
    throw error;
  }
}
