---
title: Instance Settings (인스턴스 설정)
summary: 일반 및 실험적 인스턴스 전역 설정
---

인스턴스 설정은 제어 플레인 전역 구성으로, 인스턴스 관리자가 관리합니다.

## 일반 설정

```
GET /api/instance/settings/general
```

일반 인스턴스 설정을 반환합니다.

```
PATCH /api/instance/settings/general
{
  "censorUsernameInLogs": true
}
```

일반 인스턴스 설정을 업데이트합니다. 지원되는 필드는 `censorUsernameInLogs`뿐입니다.

## 실험적 설정

```
GET /api/instance/settings/experimental
```

인스턴스의 실험적 기능 플래그를 반환합니다.

```
PATCH /api/instance/settings/experimental
{
  "enableIsolatedWorkspaces": true,
  "autoRestartDevServerWhenIdle": false,
  "enableHeartbeatFinalizationV1": false
}
```

실험적 설정을 업데이트합니다. 지원되는 필드에는 `enableIsolatedWorkspaces`, `autoRestartDevServerWhenIdle`, `enableHeartbeatFinalizationV1`과 아래 광역 검색 허용 목록이 포함됩니다.

### 광역 검색 범위 해제

세 필드는 모두 UUID 문자열 배열을 받으며 기본값은 `[]`입니다.

- `broadSearchAllowedCompanyIdsV1`: 광역 검색을 허용할 회사 목록입니다.
- `broadSearchAllowedMissionIdsV1`: 광역 검색을 허용할 미션 목록입니다.
- `broadSearchAllowedAgentIdsV1`: 광역 검색을 허용할 실행 중인 에이전트 목록입니다.

**OR 조건**으로 판단합니다. 회사, 미션, 실행 중인 에이전트 중 **하나라도** 해당 목록에 있으면 미션의 검색 제한을 해제합니다. 비어 있거나 생략된 목록은 추가 허용 권한을 부여하지 않으며 기존 차단 동작을 유지합니다. PATCH 요청에서 생략한 필드는 현재 값을 유지하고, `[]`를 보내면 해당 목록을 비웁니다.

일치하면 검색 범위 제한과 광역 탐색을 전부 해제합니다. 검색 권한 객체가 존재하는 경로라면 계획(PLAN), 계획 검토(PLAN-QA), 카드가 없는 복구 경로에도 적용됩니다. 권한 객체가 없는 곳에 새 객체를 만들거나, 회사 간 접근 경계를 변경하거나, 검색과 무관한 실행 권한을 부여하지는 않습니다.

이미 실행에 저장된 검색 권한은 그대로 유지됩니다. 허용 목록을 저장하거나 비우면 이후 권한 계산(새 실행 또는 저장된 권한이 없는 API의 대체 계산)부터 반영되며, 이미 권한이 정해진 실행을 중간에 변경하지 않습니다.

```json
{
  "broadSearchAllowedCompanyIdsV1": ["11111111-1111-4111-8111-111111111111"],
  "broadSearchAllowedMissionIdsV1": [],
  "broadSearchAllowedAgentIdsV1": []
}
```
