// server/src/services/missions/shared-types.ts
//
// [파일 목적] missions.ts 클로저 분해(P4)를 위한 공유 타입. missions.ts 내 private/지역 타입을
//   여기로 옮겨 helpers/ownerActions/supervision 모듈이 공통으로 import 가능하게.
// [외부 연결] consumer: missions.ts + P1~P3 분리 모듈. deps: @paperclipai/db(issues), issueService.
import { issues } from "@paperclipai/db";
import { issueService } from "../issues.js";

/** issues 테이블 row 타입 (missions.ts private → 공유). */
export type IssueRow = typeof issues.$inferSelect;

/** issueService.create 입력 타입 (missions.ts private → 공유). */
export type IssueCreateInput = Parameters<ReturnType<typeof issueService>["create"]>[1];

/** 범용 JSON record alias (Record<string, unknown>). */
export type JsonRecord = Record<string, unknown>;

/** mission 종단 상태(completed/cancelled) 여부. 본문은 순수 비교(MissionStatus 무의존). */
export function isTerminalMissionStatus(status: string | undefined): status is "completed" | "cancelled" {
  return status === "completed" || status === "cancelled";
}
