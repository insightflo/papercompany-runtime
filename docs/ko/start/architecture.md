---
title: 아키텍처(Architecture)
summary: 스택 개요, 요청 흐름, papercompany가 업무 시스템을 조정하는 방식
---

papercompany는 네 개의 주요 계층으로 구성된 모노레포입니다. 제품 관점에서 보면 컴퍼니 운영을 위한 컨트롤 플레인입니다. 오픈소스 Paperclip base 위에 구축되어 있으며, 미션 중심 실행, 워크플로 하니스, QA 평가로 확장되었습니다.

## 스택 개요(Stack Overview)

```
┌─────────────────────────────────────┐
│  React UI (Vite)                    │
│  Dashboard, org management, work    │
├─────────────────────────────────────┤
│  Express.js REST API (Node.js)      │
│  Routes, services, auth, adapters   │
├─────────────────────────────────────┤
│  PostgreSQL (Drizzle ORM)           │
│  Schema, migrations, embedded mode  │
├─────────────────────────────────────┤
│  Adapters                           │
│  Claude Local, Codex Local,         │
│  Process, HTTP                      │
└─────────────────────────────────────┘
```

## 기술 스택(Technology Stack)

| 계층 | 기술 |
|-------|-----------|
| 프론트엔드(Frontend) | React 19, Vite 6, React Router 7, Radix UI, Tailwind CSS 4, TanStack Query |
| 백엔드(Backend) | Node.js 20+, Express.js 5, TypeScript |
| 데이터베이스(Database) | PostgreSQL 17(또는 임베디드 PGlite), Drizzle ORM |
| 인증(Auth) | Better Auth(세션 + API 키) |
| 어댑터(Adapters) | Claude Code, Codex, Gemini, Command Code, Cursor, Pi, Antigravity, Hermes, OpenCode CLI, OpenClaw 게이트웨이, 셸 프로세스, HTTP 웹훅 |
| 패키지 매니저 | pnpm 9 워크스페이스 |

## 저장소 구조(Repository Structure)

```
paperclip/
├── ui/                          # React 프론트엔드
│   ├── src/pages/              # 라우트 페이지
│   ├── src/components/         # React 컴포넌트
│   ├── src/api/                # API 클라이언트
│   └── src/context/            # React 컨텍스트 프로바이더
│
├── server/                      # Express.js API
│   ├── src/routes/             # REST 엔드포인트
│   ├── src/services/           # 비즈니스 로직
│   ├── src/adapters/           # 에이전트 실행 어댑터
│   └── src/middleware/         # 인증, 로깅
│
├── packages/
│   ├── db/                      # Drizzle 스키마 + 마이그레이션
│   ├── shared/                  # API 타입, 상수, 검증기
│   ├── adapter-utils/           # 어댑터 인터페이스와 헬퍼
│   └── adapters/
│       ├── claude-local/          # Claude Code 어댑터
│       ├── codex-local/           # OpenAI Codex 어댑터
│       ├── gemini-local/          # Gemini 어댑터
│       ├── commandcode-local/     # Command Code 어댑터
│       ├── cursor-local/          # Cursor 어댑터
│       ├── pi-local/              # Pi 어댑터
│       ├── antigravity-local/     # Antigravity 어댑터
│       ├── opencode-local/        # OpenCode 어댑터
│       └── openclaw-gateway/      # OpenClaw 게이트웨이 어댑터
│
├── skills/                      # 에이전트 스킬
│   └── paperclip/               # 핵심 Paperclip 스킬(하트비트 프로토콜)
│
├── cli/                         # CLI 클라이언트
│   └── src/                     # 설정 및 컨트롤 플레인 명령
│
└── doc/                         # 내부 문서
```

## 요청 흐름(Request Flow)

하트비트가 발생하면:

1. **트리거(Trigger)** — 스케줄러, 수동 호출, 또는 이벤트(배정, 멘션)가 하트비트를 트리거
2. **어댑터 호출(Adapter invocation)** — 서버가 구성된 어댑터의 `execute()` 함수를 호출
3. **에이전트 프로세스(Agent process)** — 어댑터가 papercompany 환경 변수와 프롬프트와 함께 에이전트(예: Claude Code CLI)를 실행(spawn)
4. **에이전트 작업(Agent work)** — 에이전트가 papercompany의 REST API를 호출해 배정을 확인하고, 업무 항목을 체크아웃하고, 작업하고, 상태를 업데이트
5. **결과 캡처(Result capture)** — 어댑터가 stdout을 캡처하고, 사용량/비용 데이터를 파싱하고, 세션 상태를 추출
6. **런 레코드(Run record)** — 서버가 런 결과, 비용, 그리고 다음 하트비트를 위한 세션 상태를 기록

## 실행 모델(Execution Model)

어댑터는 papercompany와 에이전트 런타임 사이의 다리입니다. 실행 인프라스트럭처이지, 제품의 비즈니스 정체성은 아닙니다. 각 어댑터는 세 가지 모듈을 가진 패키지입니다:

- **서버 모듈(Server module)** — 에이전트를 실행/호출하는 `execute()` 함수와 환경 진단
- **UI 모듈(UI module)** — 런 뷰어용 stdout 파서, 에이전트 생성을 위한 구성 폼 필드
- **CLI 모듈(CLI module)** — `paperclipai run --watch`용 터미널 포맷터

기본 제공 어댑터: `claude_local`, `codex_local`, `gemini_local`, `commandcode_local`, `cursor`, `pi_local`, `antigravity_local`, `hermes_local`, `opencode_local`, `openclaw_gateway`, `process`, `http`. 어떤 런타임이든 커스텀 어댑터를 만들 수 있습니다.

papercompany는 또한 비즈니스 업무가 실제로 완료되는 더 넓은 업무 시스템 집합 위에 위치합니다. 오늘날 그러한 시스템이 모두 어댑터로 표현되지는 않지만, 제품 관점에서는 에이전트 런타임만큼이나 중요합니다.

## 핵심 설계 결정(Key Design Decisions)

- **실행 플레인이 아닌 컨트롤 플레인** — papercompany는 에이전트를 오케스트레이션할 뿐, 실행하지는 않습니다
- **컴퍼니 범위(Company-scoped)** — 모든 엔티티는 정확히 하나의 컴퍼니에 속합니다; 엄격한 데이터 경계
- **단일 담당자 업무 항목** — 원자적 체크아웃이 같은 업무 단위에 대한 동시 작업을 방지
- **어댑터 중립(Adapter-agnostic)** — HTTP API를 호출할 수 있는 런타임이면 무엇이든 에이전트로 동작
- **기본 임베디드(Embedded by default)** — 임베디드 PostgreSQL을 사용하는 제로 구성 로컬 모드
