---
title: "Interview: papercompany - 새 통합 제품 설계"
date: 2026-03-31
tags: [interview, product-design, papercompany, architecture]
type: interview
mode: full
questions_asked: 30
status: completed
---

# Interview: papercompany - paperclip + plugins 통합 신제품 설계

## Summary
paperclip 코어와 5개 plugin(workflow-engine, tool-registry, knowledge-base, worktree, scheduler)을 하나의 제품으로 통합한다. 이름은 **papercompany**. 핵심 차별점은 worktree(판단 지도)를 통한 에이전트 harness, 업무팀/유지보수팀 이중 구조, 미션 중심 UI, 미션 내 세션 지속성이다.

## Q&A Transcript

| # | Question | Answer | Branch |
|---|----------|--------|--------|
| 1 | Plugin을 서버 core에 통합하는 것이 목표인가? 아니면 plugin 구조를 유지하면서 더 긴밀하게 연결하는 것인가? | 서버 core에 통합 (5개: workflow-engine, tool-registry, knowledge-base, worktree(신규), scheduler/ops-monitor) | Integration scope |
| 2 | 통합 시 기존 기능 유지 우선인가, 새 기능 추가 우선인가? | 기존 기능 유지 + 새 기능 추가 (heartbeat 유지) | Scope |
| 3 | 이 제품의 핵심 가치는 무엇인가? | AI org platform — 에이전트가 사람처럼 회사 내에서 일함 | Vision |
| 4 | 사람(human worker)은 어떤 방식으로 플랫폼에 참여하는가? | 채널(예: Telegram)로만 참여. 플랫폼 계정 없음 | Human-AI model |
| 5 | 에이전트가 외부 서비스(Slack, GitHub 등)를 자체 호출하는가? | 에이전트가 직접 호출. human-in-loop은 escalation 시에만 | Integration model |
| 6 | worktree는 어떤 역할인가? | 판단 지도(decision map) — MUST/SHOULD/MAY 강제 수준 | Worktree |
| 7 | workflow와 worktree의 차이는? | workflow = 실행 단계(execution steps), worktree = 판단 지도(decision map) | Core concepts |
| 8 | workflow-engine 통합 방식은? | 서버 core에 완전 통합 (server/src/services/) | Architecture |
| 9 | tool-registry 통합 방식은? | 서버 core에 완전 통합 | Architecture |
| 10 | knowledge-base 통합 방식은? | 서버 core에 완전 통합 | Architecture |
| 11 | service-request-bridge 처리는? | 업무팀 → 유지보수팀 티켓 handoff 개념으로 first-class 유지 | SRB |
| 12 | heartbeat timer 대체 방안은? | scheduler(ops-monitor 방식)로 대체 — cron 기반 wakeup 제어 | Scheduler |
| 13 | 예상 에이전트 규모는? | 여러 company, 총 20-30개 | Scale |
| 14 | 인간 참여자의 역할은? | channel membership only — 플랫폼 계정/UI 없음 | Human model |
| 15 | 제거할 어댑터는? | pi-local 제거, 나머지 유지 (claude-local, codex-local, cursor-local, gemini-local, openclaw-gateway, opencode-local) | Adapters |
| 16 | v1 채널 통합은? | Telegram | Channels |
| 17 | company import/export, git workspace 유지 여부는? | 유지 (pi-local adapter만 제거) | Features |
| 18 | 유지보수팀 운영 방식은? | 유지보수 company 별도 운영. 업무팀은 코드 수정 불가. 업무팀 티켓 발행 → 유지보수팀 승인/수정 → 완료 안내 | Two-tier model |
| 19 | 업무팀/유지보수팀이 같은 인스턴스인가, 다른 서버인가? | 둘 다 가능하게 (same-instance cross-company + cross-server 모두 지원) | Deployment topology |
| 20 | cross-server 간 연결 프로토콜은? | Webhook (업무팀 서버 → 유지보수팀 서버 API 직접 호출) | SRB protocol |
| 21 | 배포 형태는? | 자체 호스팅 전용 (Self-hosted only) | Deployment |
| 22 | UI 개선 방향은? | Mission 중심 계층 구조 (Mission → Issues). 현재 flat list는 너무 복잡함 | UI |
| 23 | Worktree MUST/SHOULD/MAY 강제 방식은? | MUST=서버 hard block, SHOULD=경고+허용, MAY=가이드라인만. 사후 감사는 harness 보정용 | Worktree enforcement |
| 24 | Worktree 규칙 관리자는? | 혼합(C): 초기는 사람이 정의, 이후 에이전트가 보정 제안 → 사람 승인 | Worktree governance |
| 25 | 기존 데이터 마이그레이션 필요 여부는? | 새로 시작 OK. 나중에 참고해서 설정 | Migration |
| 26 | 제품명은? | **papercompany** | Branding |
| 27 | v1 MVP 핵심 기능 3가지는? | agents, missions, workflows — 전부 필수, v1 = 전체 통합 | Scope |
| 28 | 설치 방식은? | 현재 방식 유지: git clone + pnpm install + 수동 설정 | Deployment |
| 29 | 인증 시스템 변경 여부는? | JWT + company-scoped 그대로 유지. Codex 401 문제는 scheduler 전환으로 구조적 해결됨 | Auth |
| 30 | 제거할 core 낭비 요소는? | 세션 지속성 개선: 같은 mission 수행 중이면 session 유지 (현재 run마다 새 세션 = 낭비) | Session |

## Decisions Made

1. **제품명**: papercompany
2. **통합 방식**: 5개 plugin → server/src/services/ (plugin 구조 해체, core 통합)
3. **제거 어댑터**: pi-local만 제거
4. **인간 참여 모델**: channel-only (Telegram v1), 플랫폼 계정 없음
5. **이중 구조**: 업무 company들 + 유지보수 company (코드 수정 권한 분리)
6. **Worktree**: 신규 개념 — MUST(hard block)/SHOULD(warning)/MAY(guideline) harness
7. **Worktree 규칙 거버넌스**: 초기 사람 정의 → 에이전트 보정 제안 → 사람 승인
8. **Scheduler**: cron 기반 wakeup (ops-monitor 방식) — heartbeat timer 대체
9. **세션 지속성**: 동일 mission 내에서 session 유지 (run 간 session 공유)
10. **UI 구조**: Mission 중심 계층 (Mission → Issues 트리)
11. **SRB 프로토콜**: same-instance = cross-company, cross-server = webhook
12. **배포**: 자체 호스팅, git clone + pnpm
13. **인증**: JWT/company-scoped 유지 그대로
14. **마이그레이션**: 불필요 (fresh start)

## Scope

### In scope
- paperclip core 기반 신제품 papercompany
- 5개 서비스 core 통합: workflow-engine, tool-registry, knowledge-base, worktree(신규), scheduler
- pi-local 어댑터 제거
- Mission 중심 계층형 UI (Mission → Issues)
- Worktree harness (MUST/SHOULD/MAY 실시간 강제)
- 업무팀/유지보수팀 이중 구조 (SRB 기반 티켓 handoff)
- Telegram 채널 통합 (v1)
- Mission-scoped session 지속성
- same-instance + cross-server SRB 지원 (webhook)

### Out of scope
- 클라우드 SaaS 버전
- 기존 데이터 마이그레이션 도구
- pi-local 어댑터 (제거 대상)
- 새 배포 도구 (현재 방식 유지)

## Technical Decisions

- **언어/스택**: TypeScript, Node.js, PostgreSQL (기존 유지)
- **통합 위치**: `server/src/services/` (workflow, tools, knowledge, worktree, scheduler)
- **어댑터**: claude-local, codex-local, cursor-local, gemini-local, openclaw-gateway, opencode-local 유지
- **인증**: better-auth + JWT + company-scoped token 유지
- **채널**: Telegram Bot API (v1)
- **SRB cross-server**: HTTP webhook POST
- **세션**: mission-scoped session store (기존 per-run session 대체)
- **설치**: git clone + pnpm install + 환경변수 설정

## Constraints

- 자체 호스팅 전용 — 멀티테넌트 SaaS 설계 불필요
- 기존 paperclip API/DB 스키마에서 최대한 호환 (fresh start이지만 코드 구조 재활용)
- 업무팀 에이전트는 code/git workspace 접근 불가 (유지보수팀만)
- v1 = 전체 통합 (단계별 MVP 없음)

## Assumptions Confirmed

- 기존 heartbeat protocol은 scheduler로 대체되므로 timer 기반 wakeup 코드 제거 가능
- Codex 401 문제는 scheduler 전환으로 구조적 해결됨 (heartbeat loop 없어짐)
- human worker는 UI에 접근하지 않음 — UI는 에이전트 관리자(운영자)용

## Open Questions

- Worktree 초기 rule 정의 형식 (JSON schema? DSL? UI editor?)
- Mission-scoped session의 세션 만료/초기화 시점 (mission 완료 시? N일 후?)
- Telegram bot 아키텍처 (webhook vs polling)
