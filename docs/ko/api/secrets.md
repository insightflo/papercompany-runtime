---
title: Secrets (비밀)
summary: Secrets CRUD
---

에이전트가 환경 구성에서 참조하는 암호화된 비밀을 관리합니다.

## 비밀 목록

```
GET /api/companies/{companyId}/secrets
```

비밀 메타데이터를 반환합니다(복호화된 값은 아님).

## 비밀 생성

```
POST /api/companies/{companyId}/secrets
{
  "name": "anthropic-api-key",
  "value": "sk-ant-..."
}
```

값은 저장 시 암호화됩니다. 비밀 ID와 메타데이터만 반환됩니다.

## 비밀 수정

```
PATCH /api/secrets/{secretId}
{
  "value": "sk-ant-new-value..."
}
```

비밀의 새 버전을 생성합니다. `"version": "latest"`를 참조하는 에이전트는 다음 heartbeat에서 자동으로 새 값을 받습니다.

## 비밀 로테이션

```
POST /api/secrets/{secretId}/rotate
```

비밀을 로테이션하여 새 버전을 생성하면서, 고정된 버전 ID로 해석 가능한 과거 버전은 유지합니다.

## 비밀 삭제

```
DELETE /api/secrets/{secretId}
```

비밀을 삭제합니다.

## 비밀 제공자

```
GET /api/companies/{companyId}/secret-providers
```

회사에서 사용 가능한 비밀 제공자를 나열합니다(예: `local-encrypted`, 외부 볼트 통합).

## 에이전트 구성에서 비밀 사용하기

인라인 값 대신 에이전트 adapter 구성에서 비밀을 참조하세요:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "{secretId}",
      "version": "latest"
    }
  }
}
```

서버는 런타임에 비밀 참조를 해석하고 복호화하여 실제 값을 에이전트 프로세스 환경에 주입합니다.
