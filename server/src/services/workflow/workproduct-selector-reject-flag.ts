import { instanceSettings, type Db } from "@paperclipai/db";
import { eq } from "drizzle-orm";

/**
 * [workproduct selector reject v1 — 소비 하드닝 4단계] selector 없는 타-단계 참조의 레거시
 * 폴백/핀 소비를 workproduct_selector_required 로 명시 거부하는 스위치 — 기본 비활성.
 * 인스턴스 opt-in(enableWorkProductSelectorRejectV1) 또는 회사 allowlist
 * (enableWorkProductSelectorRejectCompanyIdsV1). 부재·형태 불량·오류는 false(fail-open:
 * 거부 없이 현행 폴백+감사 경로 유지) — 라이브 정의가 selector 를 갖추기 전까지 거부가
 * 소비를 막지 않게 하는 이관 게이트다.
 */
export async function isWorkProductSelectorRejectEnabled(db: Pick<Db, "select">, companyId: string): Promise<boolean> {
  const [row] = await db.select({ experimental: instanceSettings.experimental }).from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"));
  const settings = row?.experimental;
  return settings?.enableWorkProductSelectorRejectV1 === true
    || (Array.isArray(settings?.enableWorkProductSelectorRejectCompanyIdsV1)
      && settings.enableWorkProductSelectorRejectCompanyIdsV1.includes(companyId));
}
