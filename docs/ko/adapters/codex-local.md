---
title: Codex Local
summary: OpenAI Codex 로컬 어댑터 설정 및 구성
---

`codex_local` 어댑터는 OpenAI의 Codex CLI를 로컬에서 실행합니다. `previous_response_id` 체이닝을 통한 세션 영속화와 에이전트 워크스페이스로의 스킬 주입을 지원합니다.

## 사전 요구 사항

- Codex CLI 설치(`codex` 명령 사용 가능)
- 환경 또는 에이전트 설정에 `OPENAI_API_KEY` 설정

## 구성 필드

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `cwd` | string | 예 | 에이전트 프로세스의 작업 디렉터리(절대 경로; 권한이 허용되면 없을 때 자동 생성) |
| `model` | string | 아니요 | 사용할 모델 |
| `promptTemplate` | string | 아니요 | 모든 런에 사용되는 프롬프트 |
| `instructionsFilePath` | string | 아니요 | 유효 `cwd` 기준으로 해석되어 stdin 프롬프트 앞에 붙는 마크다운 지시 파일 |
| `env` | object | 아니요 | 환경 변수(시크릿 참조 지원) |
| `timeoutSec` | number | 아니요 | 프로세스 타임아웃(0 = 타임아웃 없음) |
| `graceSec` | number | 아니요 | 강제 종료 전 유예 시간 |
| `dangerouslyBypassApprovalsAndSandbox` | boolean | 아니요 | 안전 검사 건너뛰기(개발 전용) |

## 세션 영속화

Codex는 세션 연속성을 위해 `previous_response_id`를 사용합니다. 어댑터는 이를 하트비트 사이에 직렬화하고 복원하여 에이전트가 대화 컨텍스트를 유지할 수 있게 합니다.

## 스킬 주입

어댑터는 papercompany 스킬을 활성 워크스페이스의 `.agents/skills` 디렉터리에 주입하고, 회사별로 관리되는 `CODEX_HOME`으로 Codex를 실행합니다. 이렇게 하면 Codex 스킬, 세션, 로그 및 기타 런타임 상태가 회사별로 격리되어 체크아웃 간에 유출되지 않습니다. 또한 공유 인증/설정 연속성을 위해 사용자의 기본 Codex 홈에서 해당 격리 홈을 시드합니다.

하트비트 런 외부에서 수동으로 로컬 CLI를 사용할 때(예: `codexcoder`로 직접 실행) 다음을 사용하세요:

```sh
pnpm paperclipai agent local-cli codexcoder --company-id <company-id>
```

이 명령은 누락된 스킬을 설치하고, 에이전트 API 키를 생성한 뒤, 해당 에이전트로 실행하기 위한 셸 exports를 출력합니다.

## 환경 테스트

환경 테스트가 확인하는 항목:

- Codex CLI가 설치되어 있고 접근 가능한지
- 작업 디렉터리가 절대 경로이고 사용 가능한지(없으면 허용 시 자동 생성)
- 인증 신호(`OPENAI_API_KEY` 존재 여부)
- CLI가 실제로 실행될 수 있는지 확인하는 라이브 hello 프로브(`codex exec --json -` + `Respond with hello.` 프롬프트)

## 인증 상태 확인 및 재로그인 런북

`codex_local`이 `401 Unauthorized`(`auth error code: account_deactivated` 포함)로 실패할 때 이 절차를 사용하세요.

1. 현재 인증 상태 확인:
   - `codex auth status`
2. 필요하면 재인증:
   - `codex auth login`
3. API 키 모드를 사용 중이라면 키 유효성 확인:
   - 에이전트 설정이나 환경에 `OPENAI_API_KEY`가 유효한 키로 설정되어 있는지 확인
4. 하트비트를 한 번 다시 실행하고 런 로그에 `401 Unauthorized` 또는 `turn.failed` 이벤트가 없는지 확인합니다.

papercompany 하트비트 가드 동작:

- `codex_local` 401 인증 실패는 `codex_auth_401*` 오류 코드로 정규화됩니다.
- 이슈 런에서 이러한 실패가 발생하면 papercompany가 자동으로 이슈를 `blocked`로 설정하고 이유 코드(`CODEX_AUTH_401*`)와 복구 절차가 포함된 표준 댓글을 게시합니다.
