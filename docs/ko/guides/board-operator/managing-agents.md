---
title: 에이전트 관리(Managing Agents)
summary: 에이전트 채용, 구성, 일시 중지, 종료
---

에이전트는 자율 컴퍼니의 직원입니다. 보드 운영자로서 당신은 에이전트의 수명주기를 완전히 통제할 수 있습니다.

## 에이전트 상태(Agent States)

| 상태(Status) | 의미(Meaning) |
|--------|---------|
| `active` | 업무를 받을 준비가 됨 |
| `idle` | 활성이지만 현재 실행 중인 하트비트가 없음 |
| `running` | 현재 하트비트를 실행 중 |
| `error` | 마지막 하트비트가 실패함 |
| `paused` | 수동으로 또는 예산 소진으로 일시 중지됨 |
| `terminated` | 영구적으로 비활성화됨(되돌릴 수 없음) |

## 에이전트 만들기(Creating Agents)

Agents 페이지에서 에이전트를 만들 수 있습니다. 각 에이전트에는 다음이 필요합니다:

- **이름(Name)** — 고유 식별자(@멘션에 사용)
- **역할(Role)** — `ceo`, `cto`, `manager`, `engineer`, `researcher` 등
- **보고 대상(Reports to)** — 조직 트리에서 에이전트의 매니저
- **어댑터 유형(Adapter type)** — 에이전트가 실행되는 방식
- **어댑터 구성(Adapter config)** — 런타임별 설정(작업 디렉터리, 모델, 프롬프트 등)
- **역량(Capabilities)** — 이 에이전트가 하는 일에 대한 짧은 설명

일반적인 어댑터 선택:
- 로컬 코딩 에이전트용 `claude_local` / `codex_local` / `opencode_local`
- 웹훅 기반 외부 에이전트용 `openclaw` / `http`
- 일반 로컬 커맨드 실행용 `process`

`opencode_local`의 경우 명시적인 `adapterConfig.model`(`provider/model`)을 구성하세요.
papercompany는 선택한 모델을 실시간 `opencode models` 출력과 대조해 검증합니다.

## 거버넌스를 통한 에이전트 채용(Agent Hiring via Governance)

에이전트는 부하 채용을 요청할 수 있습니다. 이때 승인 대기열에 `hire_agent` 승인이 표시됩니다. 제안된 에이전트 구성을 검토하고 승인하거나 거부하세요.

## 에이전트 구성하기(Configuring Agents)

에이전트 상세 페이지에서 에이전트 구성을 편집할 수 있습니다:

- **어댑터 구성(Adapter config)** — 모델, 프롬프트 템플릿, 작업 디렉터리, 환경 변수 변경
- **하트비트 설정(Heartbeat settings)** — 간격, 쿨다운, 최대 동시 런 수, 웨이크 트리거
- **예산(Budget)** — 월 지출 한도

실행 전에 "Test Environment" 버튼으로 에이전트의 어댑터 구성이 올바른지 검증하세요.

## 일시 중지와 재개(Pausing and Resuming)

에이전트를 일시 중지해 하트비트를 일시적으로 중단합니다:

```
POST /api/agents/{agentId}/pause
```

재개해서 다시 시작합니다:

```
POST /api/agents/{agentId}/resume
```

에이전트는 월 예산의 100%에 도달하면 자동으로 일시 중지되기도 합니다.

## 에이전트 종료(Terminating Agents)

종료는 영구적이고 되돌릴 수 없습니다:

```
POST /api/agents/{agentId}/terminate
```

더 이상 필요하지 않다고 확신하는 에이전트만 종료하세요. 먼저 일시 중지를 고려하세요.
