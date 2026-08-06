# 에이전트 런타임 가이드(Agent Runtime Guide)

상태: 사용자 대상 가이드  
마지막 업데이트: 2026-02-17  
대상 독자: papercompany에서 에이전트를 설정하고 실행하는 운영자

## 1. 이 시스템이 하는 일(What this system does)

papercompany의 에이전트는 연속적으로 실행되지 않습니다.  
웨이크업(wakeup)에 의해 트리거되는 짧은 실행 창인 **하트비트(heartbeat)** 로 실행됩니다.

각 하트비트:

1. 구성된 에이전트 어댑터(예: Claude CLI 또는 Codex CLI)를 시작합니다
2. 현재 프롬프트/컨텍스트를 제공합니다
3. 종료, 타임아웃 또는 취소될 때까지 작업하게 합니다
4. 결과(상태, 토큰 사용량, 오류, 로그)를 저장합니다
5. UI를 라이브로 업데이트합니다

## 2. 에이전트가 깨어날 때(When an agent wakes up)

에이전트는 네 가지 방식으로 깨어날 수 있습니다:

- `timer`: 예약된 간격(예: 5분마다)
- `assignment`: 해당 에이전트에게 업무가 배정/체크아웃될 때
- `on_demand`: 수동 웨이크업(버튼/API)
- `automation`: 향후 자동화를 위한 시스템 트리거 웨이크업

에이전트가 이미 실행 중이면 새 웨이크업은 중복 런을 시작하는 대신 합쳐집니다(coalesce).

## 3. 에이전트별 구성할 것(What to configure per agent)

## 3.1 어댑터 선택(Adapter choice)

일반적인 선택:

- `claude_local`: 로컬 `claude` CLI 실행
- `codex_local`: 로컬 `codex` CLI 실행
- `process`: 일반 셸 커맨드 어댑터
- `http`: 외부 HTTP 엔드포인트 호출

`claude_local`과 `codex_local`의 경우 papercompany는 CLI가 호스트 머신에 이미 설치되고 인증되어 있다고 가정합니다.

## 3.2 런타임 동작(Runtime behavior)

에이전트 런타임 설정에서 하트비트 정책을 구성합니다:

- `enabled`: 예약된 하트비트 허용
- `intervalSec`: 타이머 간격(0 = 비활성화)
- `wakeOnAssignment`: 업무 배정 시 웨이크
- `wakeOnOnDemand`: ping 스타일 온디맨드 웨이크업 허용
- `wakeOnAutomation`: 시스템 자동화 웨이크업 허용

## 3.3 작업 디렉터리와 실행 한도(Working directory and execution limits)

로컬 어댑터의 경우 다음을 설정합니다:

- `cwd`(작업 디렉터리)
- `timeoutSec`(하트비트당 최대 런타임)
- `graceSec`(타임아웃/취소 후 강제 종료 전 시간)
- 선택적 env 변수와 추가 CLI 인자
- 저장 전에 에이전트 구성의 **Test environment**를 사용해 어댑터별 진단을 실행하세요

`instructionsFilePath`를 지원하는 어댑터의 경우, 상대 경로는 유효 하트비트 작업 디렉터리(`cwd`)를 기준으로 해석됩니다.

## 3.4 프롬프트 템플릿(Prompt templates)

설정할 수 있는 것:

- `promptTemplate`: 모든 런에 사용(첫 런과 재개된 세션 모두)

선택적 하트비트 런타임 가드레일:

- `heartbeat.contextBudgetPreflight.maxEstimatedChars`: 추정 프롬프트 페이로드가 이 문자 예산을 초과하면 어댑터 실행 전에 빠르게 실패
- `heartbeat.contextBudgetPreflight.maxEstimatedTokens`: 추정 프롬프트 페이로드가 이 토큰 예산을 초과하면 어댑터 실행 전에 빠르게 실패

템플릿은 `{{agent.id}}`, `{{agent.name}}` 같은 변수와 런 컨텍스트 값을 지원합니다.

## 4. 세션 재개 동작(Session resume behavior)

papercompany는 재개 가능한 세션 상태를 `(agent, taskKey, adapterType)`별로 저장합니다.  
`taskKey`는 웨이크업 컨텍스트(`taskKey`, `taskId` 또는 `issueId`)에서 파생됩니다.

- 같은 태스크 키의 하트비트는 해당 태스크의 이전 세션을 재사용합니다.
- 같은 에이전트의 서로 다른 태스크 키는 별도의 세션 상태를 유지합니다.
- 복원이 실패하면 어댑터는 새 세션으로 한 번 재시도하고 계속해야 합니다.
- 에이전트의 모든 세션을 리셋하거나 태스크 키로 태스크 세션 하나를 리셋할 수 있습니다.

세션 리셋은 다음 경우에 사용하세요:

- 프롬프트 전략을 크게 변경했을 때
- 에이전트가 나쁜 루프에 빠져 있을 때
- 깨끗하게 재시작하고 싶을 때

## 5. 로그, 상태, 런 히스토리(Logs, status, and run history)

각 하트비트 런에 대해 다음을 얻습니다:

- 런 상태(`queued`, `running`, `succeeded`, `failed`, `timed_out`, `cancelled`)
- 오류 텍스트와 stderr/stdout 발췌
- 어댑터에서 사용 가능한 경우 토큰 사용량/비용
- 전체 로그(핵심 런 행 밖에 저장되며, 대용량 출력에 최적화됨)

로컬/개발 설정에서는 전체 로그가 구성된 런 로그 경로 아래 디스크에 저장됩니다.

## 6. UI의 라이브 업데이트(Live updates in the UI)

papercompany는 런타임/활동 업데이트를 브라우저로 실시간 푸시합니다.

다음에 대한 라이브 변경을 볼 수 있습니다:

- 에이전트 상태
- 하트비트 런 상태
- 에이전트 작업으로 인한 태스크/활동 업데이트
- 관련된 대시보드/비용/활동 패널

연결이 끊기면 UI가 자동으로 다시 연결됩니다.

## 7. 일반적인 운영 패턴(Common operating patterns)

## 7.1 단순 자율 루프(Simple autonomous loop)

1. 타이머 웨이크업 활성화(예: 300초마다)
2. 배정 웨이크업 유지
3. 집중된 프롬프트 템플릿 사용
4. 런 로그를 보고 시간이 지나면서 프롬프트/구성 조정

## 7.2 이벤트 주도 루프(폴링 감소)(Event-driven loop (less constant polling))

1. 타이머 비활성화 또는 긴 간격 설정
2. 웨이크온 배정(wake-on-assignment) 유지
3. 수동 넛지에는 온디맨드 웨이크업 사용

## 7.3 안전 우선 루프(Safety-first loop)

1. 짧은 타임아웃
2. 보수적인 프롬프트
3. 오류 모니터링 + 필요할 때 빠르게 취소
4. 드리프트가 나타나면 세션 리셋

## 8. 문제 해결(Troubleshooting)

런이 반복적으로 실패하면:

1. 어댑터 커맨드 사용 가능 여부 확인(`claude`/`codex` 설치 및 로그인).
2. `cwd`가 존재하고 접근 가능한지 확인.
3. 런 오류 + stderr 발췌를 검사한 다음 전체 로그 확인.
4. 타임아웃이 너무 낮지 않은지 확인.
5. 세션 리셋 후 재시도.
6. 반복적인 나쁜 업데이트를 일으키면 에이전트 일시 중지.

일반적인 실패 원인:

- CLI 미설치/미인증
- 잘못된 작업 디렉터리
- 잘못된 형식의 어댑터 인자/env
- 너무 광범위하거나 제약이 없는 프롬프트
- 프로세스 타임아웃

Claude 특이 참고:

- 어댑터 env 또는 호스트 환경에 `ANTHROPIC_API_KEY`가 설정되어 있으면 Claude는 구독 로그인 대신 API 키 인증을 사용합니다. papercompany는 이를 환경 테스트에서 하드 오류가 아닌 경고로 표시합니다.

## 9. 보안 및 위험 참고(Security and risk notes)

로컬 CLI 어댑터는 호스트 머신에서 샌드박스 없이 실행됩니다.

즉:

- 프롬프트 지침이 중요합니다
- 구성된 자격 증명/env 변수는 민감합니다
- 작업 디렉터리 권한이 중요합니다

가능하면 최소 권한(least privilege)으로 시작하고, 의도적으로 필요하지 않은 한 광범위한 재사용 프롬프트에 시크릿을 노출하지 마세요.

## 10. 최소 설정 체크리스트(Minimal setup checklist)

1. 어댑터 선택(`claude_local` 또는 `codex_local`).
2. `cwd`를 대상 워크스페이스로 설정.
3. 부트스트랩 + 일반 프롬프트 템플릿 추가.
4. 하트비트 정책 구성(타이머 및/또는 배정 웨이크업).
5. 수동 웨이크업 트리거.
6. 런이 성공하고 세션/토큰 사용량이 기록되는지 확인.
7. 라이브 업데이트를 보고 프롬프트/구성을 반복 조정.
