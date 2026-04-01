아래 설계 문서를 기술 구현 가능성/보안/성능 관점에서 리뷰하세요.

특히 다음을 중점 검토:
1. Plugin ctx.state의 동시성 — 여러 이벤트가 동시에 state를 읽고 쓸 때 race condition?
2. issue.updated 이벤트의 보장 — at-least-once? exactly-once? 유실 가능성?
3. DAG cycle 감지 — dependsOn에 순환 참조가 있으면?
4. CLI Registry가 프롬프트 주입 방식인데 — 에이전트가 무시하면 강제력 없음
5. Knowledge Base의 컨텍스트 크기 — static 전체 주입 시 토큰 폭발
6. Workflow 상태를 ctx.state에 저장 — 서버 재시작/Plugin 재로드 시 복구?
7. 에이전트 동시 실행 제한 — 한 에이전트에 여러 step이 동시 할당되면?
8. 비용 추적 — workflow 단위 비용 집계가 가능한가?
9. 롤백 전략 — workflow 중간 실패 시 이전 step 결과 정리?

설계 문서:
---
title: Paperclip 에이전트 운영 플랫폼 설계
date: 2026-03-24
status: draft
author: kwak
---

# Paperclip 에이전트 운영 플랫폼 설계

## 1. 의도

진짜 회사처럼 에이전트를 운영하고 싶다. 지금은 외부 Python 스크립트, launchd, git hook 등이 흩어져 있어서 경로가 바뀌면 깨지고, 관리가 안 된다.

**목표**: 관리 안 되는 외부 스크립트를 없애고, Paperclip 안에서 완결되는 에이전트 운영 체계를 만든다.

**비유**: 직원(에이전트)이 입사하면 역할을 받고, 업무 스킬을 익히고, 사내 프로그램 권한을 받고, 사내 규정집을 열람하고, 정해진 업무 프로세스대로 일한다.

---

## 2. 에이전트 역량 모델

```
에이전트 (직원)
├── role          직책/역할               (Paperclip 기본)
├── instructions  업무 지시서              (Paperclip 기본 — .paperclip/agents/*.md)
├── skills        업무 능력               (Paperclip 기본 — SKILL.md)
├── tools         사용 가능한 프로그램      (NEW — CLI Registry)
├── knowledge     업무 지식/규정           (NEW — Knowledge Base)
└── workflows     참여하는 업무 흐름        (NEW — Workflow Engine)
```

---

## 3. 설계 원칙

1. **Paperclip Plugin으로 구현** — 서버 소스 포크 없음. upstream 업데이트 영향 없음.
2. **이슈 기반 실행** — 모든 작업은 이슈로 추적. 에이전트는 이슈 할당 시 즉시 wakeup.
3. **heartbeat 의존 제거** — 이벤트 기반 wakeup(`issue.created` → `queueIssueAssignmentWakeup`)만 사용. 빈 heartbeat 토큰 낭비 없음.
4. **기존 Routine 활용** — 반복 작업은 Paperclip Routine(cron/webhook/api)으로.
5. **구조화된 설정** — 프롬프트에 텍스트로 나열하던 것을 JSON/YAML로 구조화.
6. **배포 변동값 하드코딩 금지** — Company ID, Agent ID, Label ID 등 재설치 시 바뀌는 값을 코드에 직접 넣지 않는다. 반드시 환경변수 또는 API 조회(name/slug 기반 resolve)로 처리.

---

## 4. 신규 기능 3가지

### 4.1 CLI Registry (Tool Manager)

> "회계 담당자가 ERP 프로그램 권한을 받아서 쓰듯이"

#### 개념

회사 수준에서 CLI 도구를 등록하고, 에이전트별로 사용 권한을 부여한다.

#### 데이터 모델

```typescript
// 회사에 등록된 도구
interface Tool {
  id: string;
  companyId: string;
  name: string;                    // "데이터 수집기"
  command: string;                 // "python scripts/data-collection/collect.py"
  description: string;             // 용도 설명
  argsSchema?: JSONSchema;         // 인자 스키마 (선택)
  requiresApproval?: boolean;      // 실행 전 승인 필요 여부
  workingDirectory?: string;       // 실행 경로
  env?: Record<string, string>;    // 환경변수
  tags?: string[];                 // 분류 태그
}

// 에이전트-도구 권한 매핑
interface AgentToolGrant {
  agentId: string;
  toolId: string;
  grantedAt: string;
  grantedBy: string;               // 누가 권한 부여했는지
}
```

#### 에이전트 연동

에이전트가 실행될 때, instructions에 자동 주입:

```markdown
## 사용 가능한 도구

| 도구 | 명령어 | 설명 |
|---|---|---|
| 데이터 수집기 | `python scripts/data-collection/collect.py --date {date}` | DART/KRX 데이터 수집 |

위 도구 외에는 실행 권한이 없습니다.
```

#### 구현: Plugin 기반

- `ctx.state`에 도구 목록/권한 매핑 저장
- `agent.run.started` 이벤트 → 에이전트 instructions에 도구 목록 주입 (또는 이슈 코멘트로 전달)
- Plugin UI에서 도구 등록/권한 관리 화면 제공

---

### 4.2 Workflow Engine

> "n8n처럼 업무 흐름을 정의하고, 정해진 순서로 자동 실행"

#### 개념

이슈의 parent-child 구조 위에 의존관계(DAG)를 추가한다. 이전 단계 완료 시 다음 단계가 자동 트리거된다.

#### 데이터 모델

```typescript
interface Workflow {
  id: string;
  companyId: string;
  name: string;                     // "가즈아 일일 루틴"
  description: string;
  status: "active" | "paused" | "archived";
  steps: WorkflowStep[];
}

interface WorkflowStep {
  id: string;                       // "collect"
  title: string;                    // "데이터 수집"
  assigneeAgentId: string;
  description?: string;             // 이슈 설명으로 들어감
  dependsOn: string[];              // ["analyze", "portfolio"] — 이 step들이 모두 done이면 시작
  toolIds?: string[];               // 이 step에서 사용할 CLI 도구 (4.1 연동)
  knowledgeIds?: string[];          // 이 step에서 참조할 KB (4.3 연동)
  timeoutMinutes?: number;          // 타임아웃
  onFailure?: "retry" | "skip" | "abort_workflow";
}
```

#### 실행 흐름

```
Workflow 트리거 (Routine cron / webhook / 수동)
│
├─ Step 1 이슈 생성 (status: todo, 에이전트 할당 → 즉시 wakeup)
├─ Step 2~N 이슈 생성 (status: backlog — 대기)
│
│  [Step 1 완료]
│  └─ Plugin이 issue.updated 이벤트 수신
│     └─ dependsOn 확인: Step 2, Step 3의 의존이 모두 충족?
│        ├─ Step 2: depends_on [step1] → ✅ → status: todo + wakeup
│        └─ Step 3: depends_on [step1] → ✅ → status: todo + wakeup
│                                              (Step 2, 3 병렬 실행)
│
│  [Step 2 + Step 3 모두 완료]
│  └─ Plugin이 issue.updated 이벤트 수신
│     └─ Step 4: depends_on [step2, step3] → ✅ (join) → status: todo + wakeup
│
│  [모든 Step 완료]
│  └─ Workflow run 완료 → parent issue done
```

#### 핵심 메커니즘

- **트리거**: `issue.updated` 이벤트에서 status가 `done` 또는 `in_review`로 변경된 경우
- **의존 확인**: workflow 정의에서 해당 step에 의존하는 다음 step 찾기 → 모든 의존 step 완료 확인
- **병렬 실행**: dependsOn이 동일한 step들은 동시에 todo로 전환
- **Join**: 여러 step에 의존하는 step은 모든 의존이 완료될 때까지 대기
- **실패 처리**: onFailure 정책에 따라 재시도/건너뛰기/워크플로우 중단

#### 예시: 가즈아 일일 루틴

```yaml
name: "가즈아 일일 루틴"
trigger: routine (cron "0 7 * * *")
steps:
  - id: collect
    title: "데이터 수집"
    agent: doraemon
    tools: [gazua-data-collector]

  - id: analyze
    title: "시그널 분석"
    agent: conan
    tools: [gazua-signal-analyzer]
    dependsOn: [collect]

  - id: portfolio
    title: "포트폴리오 점검"
    agent: scrooge
    tools: [gazua-portfolio-checker]
    dependsOn: [collect]

  - id: strategy
    title: "매매 전략 수립"
    agent: zhuge_liang
    dependsOn: [analyze, portfolio]     # join — 둘 다 완료 대기

  - id: report
    title: "리포트 발행"
    agent: harry
    tools: [gazua-report-generator]
    dependsOn: [strategy]
```

실행 결과:
```
07:00  collect (도라에몽) 시작
07:15  collect 완료 → analyze (코난) + portfolio (스크루지) 동시 시작
07:30  analyze 완료, portfolio 아직 진행 중
07:35  portfolio 완료 → strategy (제갈량) 시작 (join 충족)
07:50  strategy 완료 → report (해리포터) 시작
08:05  report 완료 → workflow 완료
```

---

### 4.3 Knowledge Base (지식 관리)

> "사내 규정집, 업무 매뉴얼을 에이전트가 참조"

#### 개념

회사 수준에서 지식 소스를 등록하고, 에이전트/workflow step에서 참조할 수 있게 한다.

#### 데이터 모델

```typescript
interface KnowledgeBase {
  id: string;
  companyId: string;
  name: string;                    // "투자 규정집"
  type: "static" | "rag" | "ontology";
  description: string;

  // type별 설정
  staticConfig?: {
    filePath: string;              // 마크다운 파일 경로
  };
  ragConfig?: {
    sourcePath: string;            // 문서 디렉터리
    embeddingModel: string;        // 임베딩 모델
    chunkSize: number;
    mcpServerUrl?: string;         // MCP 서버로 제공 시
  };
  ontologyConfig?: {
    kgPath: string;                // knowledge-graph.json 경로
  };
}

interface AgentKnowledgeGrant {
  agentId: string;
  knowledgeBaseId: string;
}
```

#### 연동 방식

| KB 타입 | 에이전트 연동 방식 |
|---|---|
| static | instructions에 파일 내용 직접 주입 |
| rag | MCP 서버로 제공 → 에이전트가 검색 도구로 사용 |
| ontology | UA knowledge-graph → System Garden 오버레이 + 컨텍스트 주입 |

#### 우선 구현: static → rag 순서

Phase 1: static 파일을 이슈 코멘트나 instructions에 주입 (단순)
Phase 2: RAG MCP 서버 연동 (검색 기반)
Phase 3: 온톨로지 + UA 통합 (그래프 기반)

---

## 5. 서버 소스 수정 이력 및 복구 계획

### 확인 완료 (2026-03-24)

paperclip-orginal은 upstream master와 동일 (clean). 이전 포크(`Projects/ai/paperclip/`)에서 수정했던 것:

| 수정 | 내용 | upstream 상태 | 복구 방법 |
|---|---|---|---|
| parentId fallback 로직 | 이슈 생성 시 assignee의 defaultParentIssueId 자동 적용 | metadata 필드만 있고 **자동 fallback 없음** | Workflow Engine Plugin의 `issue.created` 이벤트에서 처리 |
| migration 0038 | defaultParentIssueId 컬럼 추가 | upstream 0038은 heartbeat_runs 관련 | metadata 방식으로 이미 대체됨 (별도 마이그레이션 불필요) |

**원칙: 서버 소스 포크 0. 모든 커스텀 로직은 Plugin으로.**

---

## 6. 다국어 지원 판단

### 결론: 당장은 안 함 (D안)

Paperclip 기본 UI에 i18n이 없고 영어 하드코딩. Plugin 슬롯은 page/sidebar/widget 등 **추가**만 가능하고, 기존 UI 텍스트 교체 불가.

| 대상 | Plugin으로 가능? |
|---|---|
| Plugin 자체 UI (work-board, workflow 등) | ✅ 한국어로 개발 |
| Paperclip 기본 UI (Dashboard, Issues 등) | ❌ 포크 필요 |
| 에이전트 프롬프트/이슈 제목 | ✅ 이미 한글 사용 중 |

**향후**: upstream에 i18n PR 기여 검토. 그 전까지는 Plugin UI만 한국어, 기본 UI는 영어 유지.

---

## 7. 기존 커스터마이징 마이그레이션

| # | 기존 (외부 스크립트) | 이후 (플랫폼 내장) | 방식 |
|---|---|---|---|
| 1 | check_paperclip_issues.py | Routine → 비전(감찰관) wakeup | Routine + 이벤트 |
| 2 | create_daily_issues.py | Routine (cron) | Routine |
| 3 | work-board 플러그인 | Plugin (유지) | Plugin |
| 4 | system-garden 플러그인 | Plugin (유지) | Plugin |
| 8 | UA post-commit hook | Plugin job (cron) | Plugin |
| 9 | Feedback Loop | Workflow step + 비전 검수 | Workflow |
| 11 | action_executor → 제갈량 위임 | Routine (webhook) → Workflow | Routine + Workflow |
| 14 | adaptive_heartbeat.py | 삭제 (heartbeat OFF, 이벤트 기반) | 불필요 |
| 16 | done 게이트키핑 | issue.updated 이벤트 → Plugin 로직 | Plugin |

**제거 가능한 외부 의존:**
- launchd plist 4개 → 삭제
- Python healthcheck 스크립트 7개 → Routine + Plugin으로 대체
- git hook → Plugin job으로 대체
- adaptive_heartbeat.py → 불필요 (heartbeat OFF)

**유지:**
- 텔레그램 /ask (Paperclip 외부 인터페이스)
- 에이전트 프롬프트 파일 (.paperclip/agents/) — 구조화 가능하나 단계적으로

---

## 8. 구현 계획

### Phase 1: 기반 (Workflow Engine Plugin)

**목표**: 이슈 상태 변화 → 다음 step 자동 트리거

```
paperclip-addon/plugins/workflow-engine/
├── src/
│   ├── manifest.ts
│   ├── worker.ts          # issue.updated 이벤트 → 흐름 제어
│   ├── workflow-store.ts  # workflow 정의 CRUD (ctx.state 기반)
│   ├── dag-engine.ts      # 의존 그래프 해석, join 판정
│   └── ui/index.tsx       # workflow 목록, 실행 현황, 시각화
├── workflows/             # 초기 workflow YAML 정의
└── package.json
```

**산출물**: 가즈아 일일 루틴이 Workflow로 돌아감

### Phase 2: CLI Registry Plugin

**목표**: 도구 등록 → 에이전트 권한 → instructions 자동 주입

```
paperclip-addon/plugins/tool-registry/
├── src/
│   ├── manifest.ts
│   ├── worker.ts          # agent.run.started → 도구 목록 주입
│   ├── tool-store.ts      # 도구/권한 CRUD
│   └── ui/index.tsx       # 도구 관리, 권한 매핑 UI
└── package.json
```

**산출물**: 에이전트가 허가된 CLI만 사용

### Phase 3: Knowledge Base Plugin

**목표**: 지식 소스 등록 → 에이전트별 접근 권한

```
paperclip-addon/plugins/knowledge-base/
├── src/
│   ├── manifest.ts
│   ├── worker.ts          # agent.run.started → 관련 KB 주입
│   ├── kb-store.ts        # KB 등록/관리
│   └── ui/index.tsx       # KB 목록, 에이전트 연결 UI
└── package.json
```

**산출물**: 에이전트가 업무 규정/매뉴얼 참조 가능

### Phase 4: 통합 및 외부 스크립트 제거

- Routine으로 일일/주간 작업 이관
- launchd plist 삭제
- Python 스크립트 아카이브
- 옵시디언/메모리 업데이트

---

## 9. 기술 판단

### Plugin SDK 적합성 확인 (2026-03-24)

| 필요 기능 | Plugin SDK 지원 | 비고 |
|---|---|---|
| issue.updated 이벤트 수신 | ✅ `ctx.events.on("issue.updated")` | 핵심 |
| 이슈 생성/상태 변경 | ✅ `ctx.issues.create/update` | 핵심 |
| 에이전트 wakeup | ✅ `ctx.agents.invoke` | 핵심 |
| 상태 저장 (workflow 정의) | ✅ `ctx.state.set/get` | 핵심 |
| cron 스케줄 job | ✅ manifest에 jobs 선언 | Routine 대체 |
| 커스텀 REST endpoint | ❌ | webhook으로 우회 가능 |
| Plugin → UI 실시간 업데이트 | ✅ `ctx.streams` (SSE) | UI 시각화 |

**결론: 서버 포크 없이 Plugin만으로 전체 구현 가능.**

---

## 10. 최종 아키텍처

```
┌──────────────────────────────────────────────────────┐
│                   Paperclip Server                   │
├──────────────────────────────────────────────────────┤
│                                                      │
│  ┌──────────┐  ┌───────────┐  ┌──────────────────┐  │
│  │ Routine  │→│ Workflow   │→│  Issue + Wakeup   │  │
│  │ (cron)   │  │ Engine    │  │  (이벤트 기반)    │  │
│  └──────────┘  │ Plugin    │  └────────┬─────────┘  │
│                └───────────┘           │             │
│                                        ▼             │
│              ┌─────────────────────────────────┐     │
│              │        Agent Runtime             │     │
│              │  ┌────────┐ ┌──────┐ ┌────────┐ │     │
│              │  │ Skills │ │Tools │ │  KB    │ │     │
│              │  │(기존)  │ │Plugin│ │Plugin  │ │     │
│              │  └────────┘ └──────┘ └────────┘ │     │
│              └─────────────────────────────────┘     │
│                                                      │
│  Plugins: workflow-engine, tool-registry,            │
│           knowledge-base, work-board, system-garden  │
└──────────────────────────────────────────────────────┘
```

**외부 의존: 0** (텔레그램 봇 제외)
