import type { Db } from "@paperclipai/db";
import { instanceSettings } from "@paperclipai/db";
import { eq } from "drizzle-orm";

const DEFAULT_SINGLETON_KEY = "default";

type SettingsReader = Pick<Db, "select">;

/**
 * run-terminal-boundary v1 — 기본 비활성. 플래그가 꺼져 있으면 기존(legacy) 종결 경로가
 * 그대로 실행되며, 이 플래그 게이팅 판단은 호출자(dag-engine/reconciler/deadlock-reconciler)
 * 책임이다. 코어 모듈(run-terminal-boundary.ts)은 플래그를 읽지 않는다.
 */
export async function isRunTerminalBoundaryV1Enabled(db: SettingsReader): Promise<boolean> {
  const row = await db
    .select({ experimental: instanceSettings.experimental })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, DEFAULT_SINGLETON_KEY))
    .then((rows) => rows[0] ?? null);
  return row?.experimental?.enableRunTerminalBoundaryV1 === true;
}
