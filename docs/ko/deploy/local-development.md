---
title: 로컬 개발
summary: 로컬 개발용 papercompany 설정
---

papercompany를 외부 의존성 없이 로컬에서 실행하세요.

## 사전 요구 사항

- Node.js 20+
- pnpm 9+

## 개발 서버 시작

```sh
pnpm install
pnpm dev
```

이 명령이 시작하는 것:

- **API 서버** — `http://localhost:3200`
- **UI** — dev 미들웨어 모드로 API 서버가 제공(동일 오리진)

Docker나 외부 데이터베이스가 필요 없습니다. papercompany가 임베디드 PostgreSQL을 자동으로 사용합니다.

## 원커맨드 부트스트랩

최초 설치 시:

```sh
pnpm paperclipai run
```

이 명령이 수행하는 것:

1. 설정이 없으면 자동 온보딩
2. 복구가 활성화된 상태로 `paperclipai doctor` 실행
3. 검사를 통과하면 서버 시작

## Tailscale/사설 인증 개발 모드

네트워크 접근을 위해 `authenticated/private` 모드로 실행하려면:

```sh
pnpm dev --tailscale-auth
```

이 명령은 사설 네트워크 접근을 위해 서버를 `0.0.0.0`에 바인딩합니다.

별칭:

```sh
pnpm dev --authenticated-private
```

추가 사설 호스트 이름 허용:

```sh
pnpm paperclipai allowed-hostname dotta-macbook-pro
```

전체 설정과 문제 해결은 [Tailscale 사설 접근](/deploy/tailscale-private-access)을 참고하세요.

## 상태 확인

```sh
curl http://localhost:3200/api/health
# -> {"status":"ok"}

curl http://localhost:3200/api/companies
# -> []
```

## 개발 데이터 초기화

로컬 데이터를 지우고 새로 시작하려면:

```sh
rm -rf ~/.paperclip/instances/default/db
pnpm dev
```

## 데이터 위치

| 데이터 | 경로 |
|------|------|
| 설정 | `~/.paperclip/instances/default/config.json` |
| 데이터베이스 | `~/.paperclip/instances/default/db` |
| 스토리지 | `~/.paperclip/instances/default/data/storage` |
| 시크릿 키 | `~/.paperclip/instances/default/secrets/master.key` |
| 로그 | `~/.paperclip/instances/default/logs` |

환경 변수로 재정의:

```sh
PAPERCLIP_HOME=/custom/path PAPERCLIP_INSTANCE_ID=dev pnpm paperclipai run
```
