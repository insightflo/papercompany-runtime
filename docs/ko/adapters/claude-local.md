---
title: Claude Local
summary: Claude Code 로컬 어댑터 설정 및 구성
---

`claude_local` 어댑터는 Anthropic의 Claude Code CLI를 로컬에서 실행합니다. 세션 영속화, 스킬 주입, 구조화된 출력 파싱을 지원합니다.

## 사전 요구 사항

- Claude Code CLI 설치(`claude` 명령 사용 가능)
- 환경 또는 에이전트 설정에 `ANTHROPIC_API_KEY` 설정

## 구성 필드

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `cwd` | string | 예 | 에이전트 프로세스의 작업 디렉터리(절대 경로; 권한이 허용되면 없을 때 자동 생성) |
| `model` | string | 아니요 | 사용할 Claude 모델(예: `claude-opus-4-6`) |
| `promptTemplate` | string | 아니요 | 모든 런에 사용되는 프롬프트 |
| `instructionsFilePath` | string | 아니요 | 유효 `cwd` 기준으로 해석되어 런타임에 주입되는 마크다운 지시 파일 |
| `env` | object | 아니요 | 환경 변수(시크릿 참조 지원) |
| `timeoutSec` | number | 아니요 | 프로세스 타임아웃(0 = 타임아웃 없음) |
| `graceSec` | number | 아니요 | 강제 종료 전 유예 시간 |
| `maxTurnsPerRun` | number | 아니요 | 하트비트당 최대 에이전트 턴 수(기본값 `300`) |
| `dangerouslySkipPermissions` | boolean | 아니요 | 권한 프롬프트 건너뛰기(개발 전용) |

## 프롬프트 템플릿

템플릿은 `{{variable}}` 치환을 지원합니다:

| 변수 | 값 |
|----------|-------|
| `{{agentId}}` | 에이전트 ID |
| `{{companyId}}` | 회사 ID |
| `{{runId}}` | 현재 런 ID |
| `{{agent.name}}` | 에이전트 이름 |
| `{{company.name}}` | 회사 이름 |

## 세션 영속화

이 어댑터는 하트비트 사이에 Claude Code 세션 ID를 유지합니다. 다음 wake에서 기존 대화를 이어가므로 에이전트가 전체 컨텍스트를 유지합니다.

세션 재개는 cwd를 인식합니다. 마지막 런 이후 에이전트의 작업 디렉터리가 변경된 경우에는 새 세션으로 시작합니다.

알 수 없는 세션 오류로 재개가 실패하면 어댑터가 자동으로 새 세션으로 재시도합니다.

## 스킬 주입

어댑터는 papercompany 스킬에 대한 심볼릭 링크가 들어 있는 임시 디렉터리를 만들고 이를 `--add-dir`로 전달합니다. 이렇게 하면 에이전트의 작업 디렉터리를 오염시키지 않으면서 스킬을 발견할 수 있습니다.

하트비트 런 외부에서 수동으로 로컬 CLI를 사용할 때(예: `claudecoder`로 직접 실행) 다음을 사용하세요:

```sh
pnpm paperclipai agent local-cli claudecoder --company-id <company-id>
```

이 명령은 `~/.claude/skills`에 papercompany 스킬을 설치하고, 에이전트 API 키를 생성한 뒤, 해당 에이전트로 실행하기 위한 셸 exports를 출력합니다.

## 환경 테스트

UI의 "Test Environment" 버튼으로 어댑터 설정을 검증할 수 있습니다. 확인 항목:

- Claude CLI가 설치되어 있고 접근 가능한지
- 작업 디렉터리가 절대 경로이고 사용 가능한지(없으면 허용 시 자동 생성)
- API 키/인증 모드 힌트(`ANTHROPIC_API_KEY` 대 구독 로그인)
- CLI 준비 상태를 확인하는 라이브 hello 프로브(`claude --print - --output-format stream-json --verbose` + `Respond with hello.` 프롬프트)
