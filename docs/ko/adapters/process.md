---
title: Process 어댑터
summary: 범용 셸 프로세스 어댑터
---

`process` 어댑터는 임의의 셸 명령을 실행합니다. 간단한 스크립트, 일회성 작업, 또는 커스텀 프레임워크로 만든 에이전트에 사용하세요.

## 사용 시기

- papercompany API를 호출하는 Python 스크립트를 실행할 때
- 커스텀 에이전트 루프를 실행할 때
- 셸 명령으로 호출할 수 있는 모든 런타임

## 사용하지 말아야 할 때

- 런 간 세션 영속화가 필요할 때(`claude_local` 또는 `codex_local` 사용)
- 에이전트가 하트비트 사이에 대화형 컨텍스트를 필요로 할 때

## 구성

| 필드 | 타입 | 필수 | 설명 |
|-------|------|----------|-------------|
| `command` | string | 예 | 실행할 셸 명령 |
| `cwd` | string | 아니요 | 작업 디렉터리 |
| `env` | object | 아니요 | 환경 변수 |
| `timeoutSec` | number | 아니요 | 프로세스 타임아웃 |

## 동작 방식

1. papercompany가 구성된 명령을 자식 프로세스로 실행합니다.
2. 표준 Paperclip 환경 변수가 주입됩니다(`PAPERCLIP_AGENT_ID`, `PAPERCLIP_API_KEY` 등).
3. 프로세스가 완료될 때까지 실행됩니다.
4. 종료 코드가 성공/실패를 결정합니다.

## 예시

Python 스크립트를 실행하는 에이전트:

```json
{
  "adapterType": "process",
  "adapterConfig": {
    "command": "python3 /path/to/agent.py",
    "cwd": "/path/to/workspace",
    "timeoutSec": 300
  }
}
```

스크립트는 주입된 환경 변수를 사용해 papercompany API로 인증하고 작업을 수행할 수 있습니다.
