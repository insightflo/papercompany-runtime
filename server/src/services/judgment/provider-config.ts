/**
 * 판단(Jev) 계층 공급자 설정 해석 — 인스턴스 일반 설정의 endpoint/model 오버라이드.
 *
 * askJudgment 전송 직전에 호출 시점 설정을 1회 읽는다. 오버라이드가 없으면 provider
 * 기본 엔드포인트(https://api.typesafe.ai)와 정의별 modelId 를 그대로 쓴다.
 * 주입 provider(테스트 목) 경로는 이 모듈을 거치지 않는다(설정 읽기 없음).
 */
import type { Db } from "@paperclipai/db";
import { instanceSettingsService } from "../instance-settings.js";

export interface JudgmentProviderConfig {
  /** TypeSafe 호환 API 루트. undefined 면 provider 기본값 사용. */
  baseUrl?: string;
  /** 정의별 modelId 를 대체하는 모델 id. undefined 면 정의값 사용. */
  modelId?: string;
}

export async function resolveJudgmentProviderConfig(db: Db): Promise<JudgmentProviderConfig> {
  const general = await instanceSettingsService(db).getGeneral();
  return {
    ...(general.judgmentBaseUrl ? { baseUrl: general.judgmentBaseUrl } : {}),
    ...(general.judgmentModelId ? { modelId: general.judgmentModelId } : {}),
  };
}

export function resolveJudgmentModel(
  config: { modelId?: string },
  definitionModelId: string,
): string {
  return config.modelId ?? definitionModelId;
}
