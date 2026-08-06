---
title: 배포 모드
summary: local_trusted 대 authenticated(사설/공개)
---

papercompany는 보안 프로필이 다른 두 가지 런타임 모드를 지원합니다.

## `local_trusted`

기본 모드. 단일 운영자 로컬 사용에 최적화되어 있습니다.

- **호스트 바인딩**: 루프백 전용(localhost)
- **인증**: 로그인 불필요
- **사용 사례**: 로컬 개발, 단독 실험
- **보드 신원**: 자동 생성된 로컬 보드 사용자

```sh
# Set during onboard
pnpm paperclipai onboard
# Choose "local_trusted"
```

## `authenticated`

로그인 필수. 두 가지 노출 정책을 지원합니다.

### `authenticated` + `private`

사설 네트워크 접근용(Tailscale, VPN, LAN).

- **인증**: Better Auth를 통한 로그인 필수
- **URL 처리**: 자동 base URL 모드(마찰 감소)
- **호스트 신뢰**: 사설 호스트 신뢰 정책 필수

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "private"
```

커스텀 Tailscale 호스트 이름 허용:

```sh
pnpm paperclipai allowed-hostname my-machine
```

### `authenticated` + `public`

인터넷 노출 배포용.

- **인증**: 로그인 필수
- **URL**: 명시적 공개 URL 필수
- **보안**: doctor에서 더 엄격한 배포 검사

```sh
pnpm paperclipai onboard
# Choose "authenticated" -> "public"
```

## 보드 클레임 플로우

`local_trusted`에서 `authenticated`로 마이그레이션할 때 papercompany는 시작 시 일회성 클레임 URL을 발급합니다:

```
/board-claim/<token>?code=<code>
```

로그인한 사용자가 이 URL을 방문하여 보드 소유권을 클레임합니다. 이 과정은:

- 현재 사용자를 인스턴스 관리자로 승격
- 자동 생성된 로컬 보드 관리자를 강등
- 클레임 사용자에게 활성 회사 멤버십 보장

## 모드 변경

배포 모드 업데이트:

```sh
pnpm paperclipai configure --section server
```

환경 변수를 통한 런타임 재정의:

```sh
PAPERCLIP_DEPLOYMENT_MODE=authenticated pnpm paperclipai run
```
