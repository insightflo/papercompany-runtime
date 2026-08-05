---
title: 어댑터 개요
summary: 어댑터가 무엇이며, 에이전트를 papercompany에 연결하는 방식
---

어댑터는 papercompany의 오케스트레이션 계층과 에이전트 런타임 사이의 다리 역할을 합니다. 각 어댑터는 특정 유형의 AI 에이전트를 호출하고 그 결과를 캡처하는 방법을 알고 있습니다.

## 어댑터의 동작 방식

하트비트가 발생하면 papercompany는:

1. 에이전트의 `adapterType`과 `adapterConfig`를 조회합니다.
2. 실행 컨텍스트와 함께 어댑터의 `execute()` 함수를 호출합니다.
3. 어댑터가 에이전트 런타임을 실행(spawn)하거나 호출합니다.
4. 어댑터가 stdout을 캡처하고 사용량/비용 데이터를 파싱한 뒤 구조화된 결과를 반환합니다.

## 기본 제공 어댑터

| 어댑터 | 타입 키 | 설명 |
|---------|----------|-------------|
| [Claude Local](/ko/adapters/claude-local) | `claude_local` | Claude Code CLI를 로컬에서 실행 |
| [Codex Local](/ko/adapters/codex-local) | `codex_local` | OpenAI Codex CLI를 로컬에서 실행 |
| [Gemini Local](/ko/adapters/gemini-local) | `gemini_local` | Gemini CLI를 로컬에서 실행 |
| [Command Code Local](/ko/adapters/commandcode-local) | `commandcode_local` | Command Code CLI를 로컬에서 실행 |
| [Cursor Local](/ko/adapters/cursor-local) | `cursor` | Cursor CLI를 로컬에서 실행 |
| [Pi Local](/ko/adapters/pi-local) | `pi_local` | Pi CLI를 로컬에서 실행 |
| [Antigravity Local](/ko/adapters/antigravity-local) | `antigravity_local` | Antigravity CLI를 로컬에서 실행 |
| [Hermes Local](/ko/adapters/hermes-local) | `hermes_local` | Hermes를 로컬에서 실행 |
| OpenCode Local | `opencode_local` | OpenCode CLI를 로컬에서 실행(멀티 프로바이더 `provider/model`) |
| [OpenClaw Gateway](/ko/adapters/openclaw-gateway) | `openclaw_gateway` | wake 페이로드를 OpenClaw webhook으로 전송 |
| [Process](/ko/adapters/process) | `process` | 임의의 셸 명령 실행 |
| [HTTP](/ko/adapters/http) | `http` | 외부 에이전트로 webhook 전송 |

## 어댑터 아키텍처

각 어댑터는 세 가지 모듈을 가진 패키지입니다:

```
packages/adapters/<name>/
  src/
    index.ts            # Shared metadata (type, label, models)
    server/
      execute.ts        # Core execution logic
      parse.ts          # Output parsing
      test.ts           # Environment diagnostics
    ui/
      parse-stdout.ts   # Stdout -> transcript entries for run viewer
      build-config.ts   # Form values -> adapterConfig JSON
    cli/
      format-event.ts   # Terminal output for `paperclipai run --watch`
```

이 모듈들을 소비하는 레지스트리는 세 가지입니다:

| 레지스트리 | 역할 |
|----------|-------------|
| **서버(Server)** | 에이전트 실행, 결과 캡처 |
| **UI** | 런 트랜스크립트 렌더링, 설정 폼 제공 |
| **CLI** | 실시간 감시용 터미널 출력 포맷 |

## 어댑터 선택하기

- **코딩 에이전트가 필요한가요?** `claude_local`, `codex_local`, `gemini_local`, `opencode_local`, `commandcode_local`, `cursor`, `pi_local`, `antigravity_local`, `hermes_local`을 사용하세요.
- **스크립트나 명령을 실행해야 하나요?** `process`를 사용하세요.
- **외부 서비스를 호출해야 하나요?** `http`를 사용하세요.
- **OpenClaw 게이트웨이가 필요한가요?** `openclaw_gateway`를 사용하세요.
- **커스텀이 필요한가요?** [자체 어댑터 만들기](/ko/adapters/creating-an-adapter) 문서를 참고하세요.
