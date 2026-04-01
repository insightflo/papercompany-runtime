OpenAI Codex v0.116.0 (research preview)
--------
workdir: /Users/kwak/Projects/paperclip/paperclip-orginal
model: gpt-5.4
provider: openai
approval: never
sandbox: workspace-write [workdir, /tmp, $TMPDIR, /Users/kwak/.codex/memories]
reasoning effort: high
reasoning summaries: none
session id: 019d1dc0-de94-7970-9656-5adbdfdde692
--------
user
아래는 Paperclip 기반 멀티 컴퍼니 에이전트 시스템에서 "크로스 컴퍼니 유지보수 요청" 구조입니다.
이 구조가 좋은 설계인지, 더 나은 대안이 있는지 리뷰해주세요.

## 현재 구조

두 회사가 Paperclip 인스턴스 하나에서 운영됨:
- 가즈아: 투자 자동화 (현업 — CLI로 직접 실행)
- 개수라발발타: 개발/연구 (IT — 코드 유지보수)

## 유지보수 요청 흐름

```
가즈아 에이전트(도라에몽)가 CLI 실행 중 에러 발생
→ 가즈아에 [유지보수] 라벨 이슈 생성 (에러 내용 포함)
→ 개수라발발타의 스파이더맨이 가즈아 API를 폴링해서 [유지보수] 이슈 감지
→ 스파이더맨이 가즈아 코드를 수정
→ 가즈아 이슈에 수정 내용 코멘트 + status: in_review
→ 가즈아 감찰관(포청천)이 검수 → done
```

## Workflow Engine으로 전환 예정

```yaml
name: "크로스 컴퍼니 유지보수"
trigger: webhook
crossCompany: true
steps:
  - id: report-bug
    companyId: gazua
    agent: reporter (동적)
  - id: fix
    companyId: gaesura
    agent: spiderman
    dependsOn: [report-bug]
  - id: report-back
    companyId: gazua
    agent: spiderman
    dependsOn: [fix]
  - id: verify
    companyId: gazua
    agent: inspector
    dependsOn: [report-back]
```

## 검토 요청

1. 이 구조 자체가 좋은 패턴인가? (현업/IT 분리, 크로스 컴퍼니 티켓)
2. 폴링 → webhook 전환이 적절한가?
3. 가즈아 코드를 개수라발발타 에이전트가 직접 수정하는 것의 보안/격리 우려?
4. 더 나은 대안이 있는가? (예: 단일 회사로 통합, 별도 유지보수 큐 등)
5. 실제 ITSM(ServiceNow, Jira Service Management) 대비 이 구조의 장단점?
mcp: stitch starting
mcp: pencil starting
mcp: pencil ready
mcp: stitch ready
mcp startup: ready: pencil, stitch
codex
요청하신 건 Paperclip의 멀티 컴퍼니 모델에 맞는 크로스 컴퍼니 유지보수 구조 리뷰입니다. 먼저 저장소의 V1 목적과 제약을 문서에서 확인한 뒤, 지금 제안하신 흐름을 그 제약에 대입해서 패턴, 보안, 대안까지 평가하겠습니다.
Plan update
  → Read required Paperclip docs and extract relevant control-plane invariants
  • Evaluate current cross-company maintenance flow against those invariants
  • Propose safer alternatives and compare with ITSM-style models
exec
/bin/zsh -lc "sed -n '1,320p' doc/SPEC-implementation.md" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "sed -n '1,220p' doc/GOAL.md" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "sed -n '1,260p' doc/PRODUCT.md" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
# Paperclip

**Paperclip is the backbone of the autonomous economy.** We are building the infrastructure that autonomous AI companies run on. Our goal is for Paperclip-powered companies to collectively generate economic output that rivals the GDP of the world's largest countries. Every decision we make should serve that: make autonomous companies more capable, more governable, more scalable, and more real.

## The Vision

Autonomous companies — AI workforces organized with real structure, governance, and accountability — will become a major force in the global economy. Not one company. Thousands. Millions. An entire economic layer that runs on AI labor, coordinated through Paperclip.

Paperclip is not the company. Paperclip is what makes the companies possible. We are the control plane, the nervous system, the operating layer. Every autonomous company needs structure, task management, cost control, goal alignment, and human governance. That's us. We are to autonomous companies what the corporate operating system is to human ones — except this time, the operating system is real software, not metaphor.

The measure of our success is not whether one company works. It's whether Paperclip becomes the default foundation that autonomous companies are built on — and whether those companies, collectively, become a serious economic force that rivals the output of nations.

## The Problem

Task management software doesn't go far enough. When your entire workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company.

## What This Is

Paperclip is the command, communication, and control plane for a company of AI agents. It is the single place where you:

 succeeded in 0ms:
# Paperclip V1 Implementation Spec

Status: Implementation contract for first release (V1)
Date: 2026-02-17
Audience: Product, engineering, and agent-integration authors
Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code

## 1. Document Role

`SPEC.md` remains the long-horizon product spec.
This document is the concrete, build-ready V1 contract.
When there is a conflict, `SPEC-implementation.md` controls V1 behavior.

## 2. V1 Outcomes

Paperclip V1 must provide a full control-plane loop for autonomous agents:

1. A human board creates a company and defines goals.
2. The board creates and manages agents in an org tree.
3. Agents receive and execute tasks via heartbeat invocations.
 succeeded in 0ms:
# Paperclip — Product Definition

## What It Is

Paperclip is the control plane for autonomous AI companies. One instance of Paperclip can run multiple companies. A **company** is a first-order object.

## Core Concepts

### Company

A company has:

- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
- **Employees** — every employee is an AI agent
- **Org structure** — who reports to whom
- **Revenue & expenses** — tracked at the company level
- **Task hierarchy** — all work traces back to the company goal

### Employees & Agents

exec
/bin/zsh -lc "sed -n '1,260p' doc/DEVELOPING.md" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "sed -n '1,260p' doc/DATABASE.md" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
# Database

Paperclip uses PostgreSQL via [Drizzle ORM](https://orm.drizzle.team/). There are three ways to run the database, from simplest to most production-ready.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.
 succeeded in 0ms:
# Developing

This project can run fully in local dev without setting up PostgreSQL manually.

## Deployment Modes

For mode definitions and intended CLI behavior, see `doc/DEPLOYMENT-MODES.md`.

Current implementation status:

- canonical model: `local_trusted` and `authenticated` (with `private/public` exposure)

## Prerequisites

- Node.js 20+
- pnpm 9+

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`.
codex
문서 기준으로는 V1의 핵심 제약이 명확합니다. `company`가 1급 객체이고, 모든 비즈니스 엔티티는 회사 단위로 스코프되며, 통신 모델은 `tasks + comments only`, 에이전트 키는 타 회사 접근 금지, 그리고 제어 평면은 실행 평면이 아니라는 점이 이번 구조 평가의 기준점입니다.
exec
/bin/zsh -lc 'rg -n "workflow|webhook|polling|heartbeat|callback" server ui packages/shared | head -n 250' in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
packages/shared/src/constants.ts:152:export const ROUTINE_TRIGGER_KINDS = ["schedule", "webhook", "api"] as const;
packages/shared/src/constants.ts:168:export const ROUTINE_RUN_SOURCES = ["schedule", "manual", "api", "webhook"] as const;
packages/shared/src/constants.ts:285:export const WAKEUP_TRIGGER_DETAILS = ["manual", "ping", "callback", "system"] as const;
packages/shared/src/constants.ts:311:  "heartbeat.run.queued",
packages/shared/src/constants.ts:312:  "heartbeat.run.status",
packages/shared/src/constants.ts:313:  "heartbeat.run.event",
packages/shared/src/constants.ts:314:  "heartbeat.run.log",
packages/shared/src/constants.ts:447:  "webhooks.receive",
packages/shared/src/constants.ts:636:/** Statuses for inbound webhook deliveries. */
server/src/startup-banner.ts:30:  heartbeatSchedulerEnabled: boolean;
server/src/startup-banner.ts:31:  heartbeatSchedulerIntervalMs: number;
server/src/startup-banner.ts:129:  const heartbeat = opts.heartbeatSchedulerEnabled
server/src/startup-banner.ts:130:    ? `enabled ${color(`(${opts.heartbeatSchedulerIntervalMs}ms)`, "dim")}`
server/src/startup-banner.ts:163:    row("Heartbeat", heartbeat),
packages/shared/src/types/routine.ts:95:  webhookUrl: string;
packages/shared/src/types/routine.ts:96:  webhookSecret: string;
packages/shared/src/types/workspace-operation.ts:13:  heartbeatRunId: string | null;
packages/shared/src/validators/cost.ts:9:  heartbeatRunId: z.string().uuid().optional().nullable(),
packages/shared/src/validators/finance.ts:9:  heartbeatRunId: z.string().uuid().optional().nullable(),
server/src/services/plugin-capability-validator.ts:10: *    ensures that declared features (tools, jobs, webhooks, UI slots)
exec
/bin/zsh -lc 'rg -n "cross.?company|company-scoped|same company|other companies|agent_api_keys|company_id" server packages/shared packages/db | head -n 250' in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
packages/db/src/schema/agent_runtime_state.ts:9:    companyId: uuid("company_id").notNull().references(() => companies.id),
packages/db/src/migrations/0000_mature_masked_marvel.sql:3:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:14:CREATE TABLE "agent_api_keys" (
packages/db/src/migrations/0000_mature_masked_marvel.sql:17:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:27:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:47:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:73:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:90:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:103:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:118:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:129:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:151:	"company_id" uuid NOT NULL,
packages/db/src/migrations/0000_mature_masked_marvel.sql:162:ALTER TABLE "activity_log" ADD CONSTRAINT "activity_log_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:164:ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:165:ALTER TABLE "agent_api_keys" ADD CONSTRAINT "agent_api_keys_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:166:ALTER TABLE "agents" ADD CONSTRAINT "agents_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:168:ALTER TABLE "approvals" ADD CONSTRAINT "approvals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:170:ALTER TABLE "cost_events" ADD CONSTRAINT "cost_events_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:175:ALTER TABLE "goals" ADD CONSTRAINT "goals_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
packages/db/src/migrations/0000_mature_masked_marvel.sql:178:ALTER TABLE "heartbeat_runs" ADD CONSTRAINT "heartbeat_runs_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
codex
저장소를 보면 현재 구현도 회사 경계 강제를 강하게 전제합니다. `same company` 검증, agent JWT의 `company_id` 고정, 워크스페이스/이슈/승인까지 모두 같은 회사 제약이 있어서, 제안하신 `crossCompany: true`는 지금 모델 위에 그냥 얹기엔 구조적으로 충돌이 큽니다.
exec
/bin/zsh -lc "sed -n '100,170p' server/src/middleware/auth.ts" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "sed -n '1,240p' packages/db/src/schema/routines.ts" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "sed -n '300,460p' server/src/services/issues.ts" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
        return;
      }
    }

    const tokenHash = hashToken(token);
    const key = await db
      .select()
      .from(agentApiKeys)
      .where(and(eq(agentApiKeys.keyHash, tokenHash), isNull(agentApiKeys.revokedAt)))
      .then((rows) => rows[0] ?? null);

    if (!key) {
      const claims = verifyLocalAgentJwt(token);
      if (!claims) {
        next();
        return;
      }

      const agentRecord = await db
        .select()
 succeeded in 0ms:
import {
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { companySecrets } from "./company_secrets.js";
import { issues } from "./issues.js";
import { projects } from "./projects.js";
import { goals } from "./goals.js";

export const routines = pgTable(
  "routines",
 succeeded in 0ms:
  for (const row of rows) {
    map.set(row.id, row);
  }
  return map;
}

function withActiveRuns(
  issueRows: IssueWithLabels[],
  runMap: Map<string, IssueActiveRunRow>,
): IssueWithLabelsAndRun[] {
  return issueRows.map((row) => ({
    ...row,
    activeRun: row.executionRunId ? (runMap.get(row.executionRunId) ?? null) : null,
  }));
}

export function issueService(db: Db) {
  const instanceSettings = instanceSettingsService(db);

  function redactIssueComment<T extends { body: string }>(comment: T, censorUsernameInLogs: boolean): T {
exec
/bin/zsh -lc "sed -n '1,260p' packages/shared/src/types/routine.ts" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
import type { IssueOriginKind } from "../constants.js";

export interface RoutineProjectSummary {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId?: string | null;
}

export interface RoutineAgentSummary {
  id: string;
  name: string;
  role: string;
  title: string | null;
  urlKey?: string | null;
}

export interface RoutineIssueSummary {
  id: string;
codex
이제 판단 기준은 충분합니다. 다음 단계는 현재안의 가장 큰 구조 리스크를 severity 순으로 정리하고, 그 뒤에 실무적으로 더 나은 모델을 제안하는 것입니다.
exec
/bin/zsh -lc "nl -ba doc/SPEC-implementation.md | sed -n '1,260p'" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "nl -ba doc/PRODUCT.md | sed -n '1,220p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
     1	# Paperclip — Product Definition
     2	
     3	## What It Is
     4	
     5	Paperclip is the control plane for autonomous AI companies. One instance of Paperclip can run multiple companies. A **company** is a first-order object.
     6	
     7	## Core Concepts
     8	
     9	### Company
    10	
    11	A company has:
    12	
    13	- A **goal** — the reason it exists ("Create the #1 AI note-taking app that does $1M MRR within 3 months")
    14	- **Employees** — every employee is an AI agent
    15	- **Org structure** — who reports to whom
    16	- **Revenue & expenses** — tracked at the company level
    17	- **Task hierarchy** — all work traces back to the company goal
    18	
    19	### Employees & Agents
    20	
 succeeded in 0ms:
     1	# Paperclip V1 Implementation Spec
     2	
     3	Status: Implementation contract for first release (V1)
     4	Date: 2026-02-17
     5	Audience: Product, engineering, and agent-integration authors
     6	Source inputs: `GOAL.md`, `PRODUCT.md`, `SPEC.md`, `DATABASE.md`, current monorepo code
     7	
     8	## 1. Document Role
     9	
    10	`SPEC.md` remains the long-horizon product spec.
    11	This document is the concrete, build-ready V1 contract.
    12	When there is a conflict, `SPEC-implementation.md` controls V1 behavior.
    13	
    14	## 2. V1 Outcomes
    15	
    16	Paperclip V1 must provide a full control-plane loop for autonomous agents:
    17	
    18	1. A human board creates a company and defines goals.
    19	2. The board creates and manages agents in an org tree.
    20	3. Agents receive and execute tasks via heartbeat invocations.
exec
/bin/zsh -lc "nl -ba server/src/services/issues.ts | sed -n '320,410p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
   320	    return {
   321	      ...comment,
   322	      body: redactCurrentUserText(comment.body, { enabled: censorUsernameInLogs }),
   323	    };
   324	  }
   325	
   326	  async function assertAssignableAgent(companyId: string, agentId: string) {
   327	    const assignee = await db
   328	      .select({
   329	        id: agents.id,
   330	        companyId: agents.companyId,
   331	        status: agents.status,
   332	      })
   333	      .from(agents)
   334	      .where(eq(agents.id, agentId))
   335	      .then((rows) => rows[0] ?? null);
   336	
   337	    if (!assignee) throw notFound("Assignee agent not found");
   338	    if (assignee.companyId !== companyId) {
   339	      throw unprocessable("Assignee must belong to same company");
exec
/bin/zsh -lc "nl -ba server/src/middleware/auth.ts | sed -n '110,170p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
   110	
   111	    if (!key) {
   112	      const claims = verifyLocalAgentJwt(token);
   113	      if (!claims) {
   114	        next();
   115	        return;
   116	      }
   117	
   118	      const agentRecord = await db
   119	        .select()
   120	        .from(agents)
   121	        .where(eq(agents.id, claims.sub))
   122	        .then((rows) => rows[0] ?? null);
   123	
   124	      if (!agentRecord || agentRecord.companyId !== claims.company_id) {
   125	        next();
   126	        return;
   127	      }
   128	
   129	      if (agentRecord.status === "terminated" || agentRecord.status === "pending_approval") {
exec
/bin/zsh -lc "nl -ba packages/db/src/schema/routines.ts | sed -n '1,180p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
     1	import {
     2	  boolean,
     3	  index,
     4	  integer,
     5	  jsonb,
     6	  pgTable,
     7	  text,
     8	  timestamp,
     9	  uniqueIndex,
    10	  uuid,
    11	} from "drizzle-orm/pg-core";
    12	import { agents } from "./agents.js";
    13	import { companies } from "./companies.js";
    14	import { companySecrets } from "./company_secrets.js";
    15	import { issues } from "./issues.js";
    16	import { projects } from "./projects.js";
    17	import { goals } from "./goals.js";
    18	
    19	export const routines = pgTable(
    20	  "routines",
exec
/bin/zsh -lc "nl -ba doc/DEVELOPING.md | sed -n '80,170p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
    80	  -e HOST=0.0.0.0 \
    81	  -e PAPERCLIP_HOME=/paperclip \
    82	  -v "$(pwd)/data/docker-paperclip:/paperclip" \
    83	  paperclip-local
    84	```
    85	
    86	Or use Compose:
    87	
    88	```sh
    89	docker compose -f docker-compose.quickstart.yml up --build
    90	```
    91	
    92	See `doc/DOCKER.md` for API key wiring (`OPENAI_API_KEY` / `ANTHROPIC_API_KEY`) and persistence details.
    93	
    94	## Docker For Untrusted PR Review
    95	
    96	For a separate review-oriented container that keeps `codex`/`claude` login state in Docker volumes and checks out PRs into an isolated scratch workspace, see `doc/UNTRUSTED-PR-REVIEW.md`.
    97	
    98	## Database in Dev (Auto-Handled)
    99	
exec
/bin/zsh -lc 'rg -n "companyId !==|belongs to same company|cross-company|other company|company boundaries|blocks cross-company" server/src packages/shared/src packages/db/src | head -n 120' in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
server/src/services/issues.ts:338:    if (assignee.companyId !== companyId) {
server/src/services/issues.ts:378:    if (workspace.companyId !== companyId) throw unprocessable("Project workspace must belong to same company");
server/src/services/issues.ts:395:    if (workspace.companyId !== companyId) throw unprocessable("Execution workspace must belong to same company");
server/src/services/issues.ts:1330:        if (comment.companyId !== issue.companyId || comment.issueId !== issue.id) {
server/src/services/finance.ts:25:  if ((row as unknown as { companyId: string }).companyId !== companyId) {
server/src/__tests__/storage-local-provider.test.ts:45:  it("blocks cross-company object access", async () => {
server/src/services/company-portability.ts:2167:      if (!issue || issue.companyId !== companyId) {
server/src/services/plugin-event-bus.ts:101:  if (filter.companyId !== undefined) {
server/src/services/plugin-event-bus.ts:102:    if (event.companyId !== filter.companyId) return false;
server/src/services/issue-approvals.ts:36:    if (issue.companyId !== approval.companyId) {
server/src/services/issue-approvals.ts:155:        if (row.companyId !== approval.companyId) {
server/src/services/company-skills.ts:1574:    if (!skill || skill.companyId !== companyId) return null;
server/src/services/company-skills.ts:1582:    if (!skill || skill.companyId !== companyId) return null;
server/src/services/company-skills.ts:1624:    if (!skill || skill.companyId !== companyId) return null;
server/src/services/company-skills.ts:1721:    if (!skill || skill.companyId !== companyId) throw notFound("Skill not found");
server/src/services/company-skills.ts:1761:    if (!skill || skill.companyId !== companyId) return null;
server/src/routes/issues.ts:84:    if (!actorAgent || actorAgent.companyId !== companyId) {
server/src/routes/issues.ts:1443:    if (issue.companyId !== companyId) {
server/src/services/agents.ts:262:    if (manager.companyId !== companyId) {
server/src/services/agents.ts:676:        if (!byId || byId.companyId !== companyId) {
exec
/bin/zsh -lc "nl -ba server/src/services/routines.ts | sed -n '150,220p'" in /Users/kwak/Projects/paperclip/paperclip-orginalexec
/bin/zsh -lc "nl -ba server/src/routes/authz.ts | sed -n '1,60p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
   150	      .where(eq(routines.id, id))
   151	      .then((rows) => rows[0] ?? null);
   152	  }
   153	
   154	  async function getTriggerById(id: string) {
   155	    return db
   156	      .select()
   157	      .from(routineTriggers)
   158	      .where(eq(routineTriggers.id, id))
   159	      .then((rows) => rows[0] ?? null);
   160	  }
   161	
   162	  async function assertRoutineAccess(companyId: string, routineId: string) {
   163	    const routine = await getRoutineById(routineId);
   164	    if (!routine) throw notFound("Routine not found");
   165	    if (routine.companyId !== companyId) throw forbidden("Routine must belong to same company");
   166	    return routine;
   167	  }
   168	
   169	  async function assertAssignableAgent(companyId: string, agentId: string) {
 succeeded in 0ms:
     1	import type { Request } from "express";
     2	import { forbidden, unauthorized } from "../errors.js";
     3	
     4	export function assertBoard(req: Request) {
     5	  if (req.actor.type !== "board") {
     6	    throw forbidden("Board access required");
     7	  }
     8	}
     9	
    10	export function assertCompanyAccess(req: Request, companyId: string) {
    11	  if (req.actor.type === "none") {
    12	    throw unauthorized();
    13	  }
    14	  if (req.actor.type === "agent" && req.actor.companyId !== companyId) {
    15	    throw forbidden("Agent key cannot access another company");
    16	  }
    17	  if (req.actor.type === "board" && req.actor.source !== "local_implicit" && !req.actor.isInstanceAdmin) {
    18	    const allowedCompanies = req.actor.companyIds ?? [];
    19	    if (!allowedCompanies.includes(companyId)) {
    20	      throw forbidden("User does not have access to this company");
exec
/bin/zsh -lc "nl -ba server/src/__tests__/storage-local-provider.test.ts | sed -n '35,65p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
    35	      body: content,
    36	    });
    37	
    38	    const fetched = await service.getObject("company-1", stored.objectKey);
    39	    const fetchedBody = await readStreamToBuffer(fetched.stream);
    40	
    41	    expect(fetchedBody.toString("utf8")).toBe("hello image bytes");
    42	    expect(stored.sha256).toHaveLength(64);
    43	  });
    44	
    45	  it("blocks cross-company object access", async () => {
    46	    const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-storage-"));
    47	    tempRoots.push(root);
    48	
    49	    const service = createStorageService(createLocalDiskStorageProvider(root));
    50	    const stored = await service.putFile({
    51	      companyId: "company-a",
    52	      namespace: "issues/issue-1",
    53	      originalFilename: "demo.png",
    54	      contentType: "image/png",
exec
/bin/zsh -lc "nl -ba server/src/routes/companies.ts | sed -n '150,210p'" in /Users/kwak/Projects/paperclip/paperclip-orginal succeeded in 0ms:
   150	    const companyId = req.params.companyId as string;
   151	    await assertCanManagePortability(req, companyId, "exports");
   152	    const preview = await portability.previewExport(companyId, req.body);
   153	    res.json(preview);
   154	  });
   155	
   156	  router.post("/:companyId/exports", validate(companyPortabilityExportSchema), async (req, res) => {
   157	    const companyId = req.params.companyId as string;
   158	    await assertCanManagePortability(req, companyId, "exports");
   159	    const result = await portability.exportBundle(companyId, req.body);
   160	    res.json(result);
   161	  });
   162	
   163	  router.post("/:companyId/imports/preview", validate(companyPortabilityPreviewSchema), async (req, res) => {
   164	    const companyId = req.params.companyId as string;
   165	    await assertCanManagePortability(req, companyId, "imports");
   166	    if (req.body.target.mode === "existing_company" && req.body.target.companyId !== companyId) {
   167	      throw forbidden("Safe import route can only target the route company");
   168	    }
   169	    if (req.body.collisionStrategy === "replace") {
codex
**Findings**

1. `crossCompany: true`로 외부 회사 에이전트가 다른 회사의 이슈/워크스페이스를 직접 수행하게 만드는 건, 현재 Paperclip의 핵심 테넌시 모델과 정면 충돌합니다. V1은 “모든 비즈니스 레코드는 정확히 한 회사에 속함”, “가시성은 같은 회사 내부”, “agent key는 다른 회사 접근 금지”를 전제로 합니다. 지금 모델 위에선 작은 확장이 아니라 보안/권한/감사 모델 재설계입니다.  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L33)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L127)  
[server/src/routes/authz.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/routes/authz.ts#L10)

2. 가즈아 이슈를 개수라발발타 에이전트가 직접 처리하면, 과업의 goal lineage와 비용 귀속이 흐려집니다. 현재 task는 회사 goal chain에 매달려야 하고, cost event도 agent와 company에 귀속됩니다. 외부 회사 에이전트가 타사 이슈에 직접 매달리면 “누구의 일인가”가 모호해집니다.  
[doc/PRODUCT.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/PRODUCT.md#L42)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L188)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L237)

3. 보안 면에서도 “개수라발발타 에이전트가 가즈아 코드를 직접 수정”은 위험합니다. 현재 워크스페이스, company-scoped Codex home, secret/provider 모델은 회사 경계를 기준으로 나뉘어 있습니다. 타사 에이전트에 직접 수정 권한을 주면 secret 노출, 잘못된 repo/branch 오염, 감사 책임 혼선이 생깁니다.  
[doc/DEVELOPING.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/DEVELOPING.md#L125)

4. `polling -> webhook` 전환 자체는 맞는 방향이지만, “foreign agent 직접 실행”을 webhook으로 바꾸는 것만으로는 설계가 좋아지지 않습니다. 현재 routines/workflows도 회사 스코프를 강하게 전제합니다. webhook은 트리거일 뿐이고, 실제로는 내구성 있는 inbox/bridge 레이어가 필요합니다.  
[packages/db/src/schema/routines.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/routines.ts#L19)  
[server/src/services/routines.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/routines.ts#L162)

**권장안**

가장 좋은 패턴은 `직접 크로스 컴퍼니 실행`이 아니라 `양사 이슈를 연결하는 서비스 요청 브리지`입니다.

- 가즈아에는 고객 관점의 `maintenance request issue`를 둡니다.
- 브리지 레이어가 개수라발발타에 별도의 `provider work order issue`를 생성합니다.
- 스파이더맨은 개수라발발타 이슈만 수행합니다.
- 산출물은 `patch/PR/artifact/report` 형태로 가즈아 쪽 이슈에 첨부하거나 링크합니다.
- 최종 적용은 가즈아 소속 에이전트나 보드가 수행합니다.
- 두 이슈는 `linked_issue_id` 또는 별도 `service_request` 엔터티로 묶고, 상태만 동기화합니다.

이렇게 하면:
- 회사 경계 유지
- 각 회사 goal/budget/audit 분리
- provider/customer 관계 모델링 가능
- 나중에 SLA, 승인, 과금 코드까지 확장 가능

**질문별 답변**

1. 현업/IT 분리 자체는 좋은 패턴입니다. 다만 “크로스 컴퍼니 티켓 하나를 외부 회사 에이전트가 직접 집행”하는 형태는 현재 Paperclip 철학과는 안 맞습니다. “티켓 연동”은 좋고, “실행 권한 공유”는 나쁩니다.

2. 폴링에서 webhook으로 가는 건 적절합니다. 단, `webhook -> mirrored issue 생성 -> provider queue 처리`여야 합니다. `webhook -> foreign agent가 requester 회사에서 바로 작업`은 비추천입니다.

3. 직접 수정은 원칙적으로 피하는 게 맞습니다. 꼭 필요하면 최소한:
- read-only 진단과 patch 제안만 허용
- 별도 worktree/ephemeral clone 사용
- requester secret 비노출
- 적용 권한은 requester 회사 에이전트만 보유
이 정도는 필요합니다.

4. 더 나은 대안은 세 가지입니다.
- 추천: 멀티 컴퍼니 유지 + `service request bridge`
- 단순화: 실제로 한 조직이면 단일 회사 + 팀/라벨 분리
- 강한 격리: 회사마다 Paperclip 인스턴스 분리, cross-instance service desk 연동

5. ITSM 대비 장점은 agent 실행 컨텍스트와 작업 산출물 연결이 자연스럽고 자동화 friction이 낮다는 점입니다. 단점은 SLA, 서비스 카탈로그, 에스컬레이션, change approval, provider/requester 모델이 아직 ITSM만큼 성숙하지 않다는 점입니다. 지금 케이스는 솔직히 Paperclip의 기본 회사 모델보다는 “내부 MSP/공용 IT 서비스데스크” 문제에 더 가깝습니다.

한 줄로 정리하면, `멀티 컴퍼니는 유지하되, cross-company execution이 아니라 cross-company request linking으로 설계`하는 쪽이 더 안전하고 Paperclip의 현재 모델과도 잘 맞습니다. 원하시면 다음 턴에 이걸 기준으로 `service_request` 데이터모델과 workflow YAML 초안까지 바로 설계해드리겠습니다.
tokens used
68,628
**Findings**

1. `crossCompany: true`로 외부 회사 에이전트가 다른 회사의 이슈/워크스페이스를 직접 수행하게 만드는 건, 현재 Paperclip의 핵심 테넌시 모델과 정면 충돌합니다. V1은 “모든 비즈니스 레코드는 정확히 한 회사에 속함”, “가시성은 같은 회사 내부”, “agent key는 다른 회사 접근 금지”를 전제로 합니다. 지금 모델 위에선 작은 확장이 아니라 보안/권한/감사 모델 재설계입니다.  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L33)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L127)  
[server/src/routes/authz.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/routes/authz.ts#L10)

2. 가즈아 이슈를 개수라발발타 에이전트가 직접 처리하면, 과업의 goal lineage와 비용 귀속이 흐려집니다. 현재 task는 회사 goal chain에 매달려야 하고, cost event도 agent와 company에 귀속됩니다. 외부 회사 에이전트가 타사 이슈에 직접 매달리면 “누구의 일인가”가 모호해집니다.  
[doc/PRODUCT.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/PRODUCT.md#L42)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L188)  
[doc/SPEC-implementation.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/SPEC-implementation.md#L237)

3. 보안 면에서도 “개수라발발타 에이전트가 가즈아 코드를 직접 수정”은 위험합니다. 현재 워크스페이스, company-scoped Codex home, secret/provider 모델은 회사 경계를 기준으로 나뉘어 있습니다. 타사 에이전트에 직접 수정 권한을 주면 secret 노출, 잘못된 repo/branch 오염, 감사 책임 혼선이 생깁니다.  
[doc/DEVELOPING.md](/Users/kwak/Projects/paperclip/paperclip-orginal/doc/DEVELOPING.md#L125)

4. `polling -> webhook` 전환 자체는 맞는 방향이지만, “foreign agent 직접 실행”을 webhook으로 바꾸는 것만으로는 설계가 좋아지지 않습니다. 현재 routines/workflows도 회사 스코프를 강하게 전제합니다. webhook은 트리거일 뿐이고, 실제로는 내구성 있는 inbox/bridge 레이어가 필요합니다.  
[packages/db/src/schema/routines.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/packages/db/src/schema/routines.ts#L19)  
[server/src/services/routines.ts](/Users/kwak/Projects/paperclip/paperclip-orginal/server/src/services/routines.ts#L162)

**권장안**

가장 좋은 패턴은 `직접 크로스 컴퍼니 실행`이 아니라 `양사 이슈를 연결하는 서비스 요청 브리지`입니다.

- 가즈아에는 고객 관점의 `maintenance request issue`를 둡니다.
- 브리지 레이어가 개수라발발타에 별도의 `provider work order issue`를 생성합니다.
- 스파이더맨은 개수라발발타 이슈만 수행합니다.
- 산출물은 `patch/PR/artifact/report` 형태로 가즈아 쪽 이슈에 첨부하거나 링크합니다.
- 최종 적용은 가즈아 소속 에이전트나 보드가 수행합니다.
- 두 이슈는 `linked_issue_id` 또는 별도 `service_request` 엔터티로 묶고, 상태만 동기화합니다.

이렇게 하면:
- 회사 경계 유지
- 각 회사 goal/budget/audit 분리
- provider/customer 관계 모델링 가능
- 나중에 SLA, 승인, 과금 코드까지 확장 가능

**질문별 답변**

1. 현업/IT 분리 자체는 좋은 패턴입니다. 다만 “크로스 컴퍼니 티켓 하나를 외부 회사 에이전트가 직접 집행”하는 형태는 현재 Paperclip 철학과는 안 맞습니다. “티켓 연동”은 좋고, “실행 권한 공유”는 나쁩니다.

2. 폴링에서 webhook으로 가는 건 적절합니다. 단, `webhook -> mirrored issue 생성 -> provider queue 처리`여야 합니다. `webhook -> foreign agent가 requester 회사에서 바로 작업`은 비추천입니다.

3. 직접 수정은 원칙적으로 피하는 게 맞습니다. 꼭 필요하면 최소한:
- read-only 진단과 patch 제안만 허용
- 별도 worktree/ephemeral clone 사용
- requester secret 비노출
- 적용 권한은 requester 회사 에이전트만 보유
이 정도는 필요합니다.

4. 더 나은 대안은 세 가지입니다.
- 추천: 멀티 컴퍼니 유지 + `service request bridge`
- 단순화: 실제로 한 조직이면 단일 회사 + 팀/라벨 분리
- 강한 격리: 회사마다 Paperclip 인스턴스 분리, cross-instance service desk 연동

5. ITSM 대비 장점은 agent 실행 컨텍스트와 작업 산출물 연결이 자연스럽고 자동화 friction이 낮다는 점입니다. 단점은 SLA, 서비스 카탈로그, 에스컬레이션, change approval, provider/requester 모델이 아직 ITSM만큼 성숙하지 않다는 점입니다. 지금 케이스는 솔직히 Paperclip의 기본 회사 모델보다는 “내부 MSP/공용 IT 서비스데스크” 문제에 더 가깝습니다.

한 줄로 정리하면, `멀티 컴퍼니는 유지하되, cross-company execution이 아니라 cross-company request linking으로 설계`하는 쪽이 더 안전하고 Paperclip의 현재 모델과도 잘 맞습니다. 원하시면 다음 턴에 이걸 기준으로 `service_request` 데이터모델과 workflow YAML 초안까지 바로 설계해드리겠습니다.
