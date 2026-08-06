---
title: Command Code Local
summary: Command Code CLI 로컬 어댑터 설정 및 구성
---

`commandcode_local` 어댑터는 [Command Code](https://commandcode.ai) CLI(`cmd`)를 papercompany 에이전트 런타임으로 로컬에서 실행합니다. 헤드리스(비대화형) 런을 실행하고 구조화된 출력을 캡처합니다.

## 사전 요구 사항

- Command Code CLI 설치(`cmd` 명령 사용 가능, v1.7 이상)
- 에이전트 키 플로우로 구성된 에이전트 API 키

## 구성 필드

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `cwd` | string | 예 | 에이전트 프로세스의 작업 디렉터리 |
| `model` | string | 아니요 | 사용할 모델(예: `claude-sonnet-5`) |
| `promptTemplate` | string | 아니요 | 모든 런에 사용되는 프롬프트 |
| `instructionsFilePath` | string | 아니요 | 유효 `cwd` 기준으로 해석되어 런타임에 주입되는 마크다운 지시 파일 |
| `env` | object | 아니요 | 환경 변수(시크릿 참조 지원) |
| `timeoutSec` | number | 아니요 | 프로세스 타임아웃(0 = 타임아웃 없음) |
| `graceSec` | number | 아니요 | 강제 종료 전 유예 시간 |
| `maxTurnsPerRun` | number | 아니요 | 하트비트당 최대 에이전트 턴 수 |
| `dangerouslySkipPermissions` | boolean | 아니요 | 권한 프롬프트 건너뛰기(개발 전용) |

## 스킬 주입

스킬은 에이전트 워크스페이스의 `.agents/skills` 디렉터리에 주입되며, Command Code가 기본적으로 발견하는 저장소 로컬 스킬 레이아웃을 그대로 따릅니다.

## 로컬 CLI 설정

하트비트 런 외부에서 수동으로 로컬 CLI를 사용할 때:

```sh
pnpm paperclipai agent local-cli <agent-id> --company-id <company-id>
```

이 명령은 Command Code 전역 스킬 디렉터리(`~/.commandcode/skills`)에 papercompany 스킬을 설치하고, 에이전트 API 키를 생성한 뒤, 해당 에이전트로 실행하기 위한 셸 exports를 출력합니다.

## 환경 테스트

"Test Environment" 검사가 확인하는 항목:

- `cmd` CLI가 설치되어 있고 접근 가능한지
- 작업 디렉터리가 절대 경로이고 사용 가능한지
- 모델 구성이 해석되는지
