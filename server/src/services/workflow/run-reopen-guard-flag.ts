import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { TERMINAL_WORKFLOW_STATUSES } from "../missions/mission-runtime-manager.js";

const DEFAULT_SINGLETON_KEY = "default";

type SettingsReader = Pick<Db, "select">;

/**
 * [run-reopen-guard v1] 종결 run 재오픈 가드 스위치 — 기본 비활성. 플래그가 꺼져 있으면
 * 기존(legacy) 재개/재계산 경로가 그대로 실행되며, 이 플래그 게이팅 판단은 호출자
 * (dag-engine/workflow-store/retry-issue-less-manual/instant-advance) 책임이다.
 * 계약: "종결된 권한은 관측 사실만으로 부활하지 않는다" — 공식 복구 경로(PR-2b)만 재개할 수 있다.
 */
export async function isRunReopenGuardEnabled(db: SettingsReader): Promise<boolean> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.experimental?.enableRunReopenGuardV1 === true;
}

/**
 * [run-recovery-service v1 — PR-2b] 공식 복구 서비스 스위치 — 기본 비활성. 켜지면 종결
 * 실행의 재개(resume/감독 재시도/언블록 해결)가 recoverTerminalRun 의 1회 소비·권한버전
 * 검증을 경유한다. [봇 지적 교정] reopenGuard 도 함께 켜져 있어야만 활성으로 판정한다 —
 * 가드가 꺼지면 legacy 재개 경로가 살아나 복구 서비스의 소비 기록과 어긋나기 때문이다.
 * 이 판정을 이 함수 하나에 두어 세 호출부의 게이팅 불일치를 원천 봉쇄한다.
 */
export async function isRunRecoveryServiceEnabled(db: SettingsReader): Promise<boolean> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.experimental?.enableRunReopenGuardV1 === true
    && row?.experimental?.enableRunRecoveryServiceV1 === true;
}

/**
 * [work-product binding v1] tool 스텝 인자의 산출물 참조를 consumer step-run 단위로
 * 고정하는 스위치 — 기본 비활성. off 는 현재 대표 재해석 경로를 유지한다.
 */
export async function isWorkProductBindingEnabled(db: SettingsReader): Promise<boolean> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.experimental?.enableWorkProductBindingV1 === true;
}

/**
 * 재오픈 가드가 "종결 권위"로 취급하는 run 상태 집합. 이 상태의 run 은 관측 사실(재계산/
 * 즉시 재평가)만으로는 running 으로 부활하지 않는다. failed 는 종결이지만 PR-2b 공식 복구
 * 서비스까지 기존 resume/retry 경로(CAS + 권한버전 범프)로 재개를 허용한다.
 * [봇 지적 교정] 집합을 재정의하지 않고 미션 런타임 종결 집합을 그대로 참조한다 —
 * finalize/트리거/가드가 서로 다른 "종결" 정의로 갈라지는 것을 방지한다.
 */
export const RUN_REOPEN_TERMINAL_STATUSES: ReadonlySet<string> = TERMINAL_WORKFLOW_STATUSES;

/**
 * 재오픈 가드 on 경로에서 resume/재시도 쓰기가 허용되는 상태 CAS 집합.
 * failed|running 만 허용 — cancelled·completed·aborted·timed-out 은 재오픈 불가.
 */
export const RUN_REOPEN_RESUMABLE_STATUSES: readonly string[] = ["failed", "running"];
