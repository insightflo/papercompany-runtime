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
  "defaultStorageProvider": "local",
  "allowedHostnames": ["paperclip.example.com"]
}
```

일반 인스턴스 설정을 업데이트합니다.

## 실험적 설정

```
GET /api/instance/settings/experimental
```

인스턴스의 실험적 기능 플래그를 반환합니다.

```
PATCH /api/instance/settings/experimental
{
  "workflowNativeSchedulerEnabled": true
}
```

실험적 설정을 업데이트합니다.
