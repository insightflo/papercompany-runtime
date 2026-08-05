---
title: 시크릿 관리
summary: 마스터 키, 암호화, 엄격 모드
---

papercompany는 로컬 마스터 키를 사용해 저장 시 시크릿을 암호화합니다. 민감한 값(API 키, 토큰)을 포함하는 에이전트 환경 변수는 암호화된 시크릿 참조로 저장됩니다.

## 기본 제공자: `local_encrypted`

시크릿은 다음 위치에 저장된 로컬 마스터 키로 암호화됩니다:

```
~/.paperclip/instances/default/secrets/master.key
```

이 키는 온보딩 중에 자동 생성됩니다. 키는 머신을 벗어나지 않습니다.

## 설정

### CLI 설정

온보딩이 기본 시크릿 설정을 작성합니다:

```sh
pnpm paperclipai onboard
```

시크릿 설정 업데이트:

```sh
pnpm paperclipai configure --section secrets
```

시크릿 설정 검증:

```sh
pnpm paperclipai doctor
```

### 환경 변수 재정의

| 변수 | 설명 |
|----------|-------------|
| `PAPERCLIP_SECRETS_MASTER_KEY` | base64, hex 또는 원시 문자열 형식의 32바이트 키 |
| `PAPERCLIP_SECRETS_MASTER_KEY_FILE` | 커스텀 키 파일 경로 |
| `PAPERCLIP_SECRETS_STRICT_MODE` | `true`로 설정하면 시크릿 참조를 강제 |

## 엄격 모드

엄격 모드가 활성화되면 민감한 env 키(`*_API_KEY`, `*_TOKEN`, `*_SECRET` 패턴 매칭)는 인라인 평문 값 대신 시크릿 참조를 사용해야 합니다.

```sh
PAPERCLIP_SECRETS_STRICT_MODE=true
```

로컬 신뢰 모드를 넘어서는 모든 배포에 권장됩니다.

## 인라인 시크릿 마이그레이션

설정에 인라인 API 키가 있는 기존 에이전트가 있다면 암호화된 시크릿 참조로 마이그레이션하세요:

```sh
pnpm secrets:migrate-inline-env         # dry run
pnpm secrets:migrate-inline-env --apply # apply migration
```

## 에이전트 설정의 시크릿 참조

에이전트 환경 변수는 시크릿 참조를 사용합니다:

```json
{
  "env": {
    "ANTHROPIC_API_KEY": {
      "type": "secret_ref",
      "secretId": "8f884973-c29b-44e4-8ea3-6413437f8081",
      "version": "latest"
    }
  }
}
```

서버는 런타임에 이를 해석하고 복호화하여 실제 값을 에이전트 프로세스 환경에 주입합니다.
