---
title: Channel Configuration (채널 구성)
summary: 회사 채널 구성과 연결 테스트
---

채널은 제어 플레인을 외부 메시징 또는 이벤트 시스템에 연결합니다.

## 채널 구성 조회

```
GET /api/companies/{companyId}/channel/config
```

회사의 채널 구성을 반환합니다.

## 채널 구성 설정

```
PUT /api/companies/{companyId}/channel/config
{
  "type": "slack",
  "settings": {
    "token": "{encrypted-token}",
    "channel": "#ops"
  }
}
```

채널 구성을 업데이트합니다.

## 채널 테스트

```
POST /api/companies/{companyId}/channel/test
```

구성된 채널에 대한 연결을 테스트하고 결과를 반환합니다.
