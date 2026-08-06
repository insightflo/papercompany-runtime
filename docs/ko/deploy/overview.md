---
title: 배포 개요
summary: 배포 모드 한눈에 보기
---

papercompany는 제로 프릭션 로컬부터 인터넷 노출 프로덕션까지 세 가지 배포 구성을 지원합니다.

## 배포 모드

| 모드 | 인증 | 적합한 상황 |
|------|------|----------|
| `local_trusted` | 로그인 불필요 | 단일 운영자 로컬 머신 |
| `authenticated` + `private` | 로그인 필요 | 사설 네트워크(Tailscale, VPN, LAN) |
| `authenticated` + `public` | 로그인 필요 | 인터넷 노출 클라우드 배포 |

## 빠른 비교

### 로컬 신뢰 모드(Local Trusted, 기본값)

- 루프백 전용 호스트 바인딩(localhost)
- 사람 로그인 플로우 없음
- 가장 빠른 로컬 시작
- 적합한 상황: 단독 개발과 실험

### 인증 + 사설(Authenticated + Private)

- Better Auth를 통한 로그인 필수
- 네트워크 접근을 위해 모든 인터페이스에 바인딩
- 자동 base URL 모드(마찰 감소)
- 적합한 상황: Tailscale 또는 로컬 네트워크를 통한 팀 접근

### 인증 + 공개(Authenticated + Public)

- 로그인 필수
- 명시적 공개 URL 필수
- 더 엄격한 보안 검사
- 적합한 상황: 클라우드 호스팅, 인터넷 노출 배포

## 모드 선택하기

- **papercompany를 그냥 시험해 보려면?** `local_trusted` 사용(기본값)
- **사설 네트워크에서 팀과 공유하려면?** `authenticated` + `private` 사용
- **클라우드에 배포하려면?** `authenticated` + `public` 사용

온보딩 중에 모드를 설정하세요:

```sh
pnpm paperclipai onboard
```

또는 나중에 업데이트하세요:

```sh
pnpm paperclipai configure --section server
```

A1 Papercompany GitHub Actions 배포 플로우는 [A1 GitHub Actions 배포](./a1-github-actions.md)를 참고하세요.
