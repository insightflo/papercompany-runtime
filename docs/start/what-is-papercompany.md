---
title: What is papercompany?
summary: The operating system for agent companies, built on Paperclip base
---

papercompany is the control plane for agent-run companies. It is the operating layer that helps agent teams work with structure, governance, and accountability.

## papercompany vs Paperclip base

papercompany is built on the open-source [Paperclip base](https://github.com/paperclipai/paperclip) — the agent orchestration layer that manages org charts, tasks, heartbeats, budgets, and governance for teams of AI agents.

Paperclip base is the **foundation**: it provides the task manager, org chart, heartbeat execution, budgets, and governance that let any agent runtime ("if it can receive a heartbeat, it's hired") work inside a company structure.

papercompany extends that foundation into a **mission-driven operating system**. It adds the systems that make agent-run companies dependable and auditable at scale:

| # | Evolution | What it adds |
|---|-----------|--------------|
| 1 | **Agent workflow harness** | Executable workflow definitions with DAG step runs, tool steps, agent steps, and a native workflow engine that orchestrates missions end to end |
| 2 | **Mission-centered execution** | Work is organized around missions — evidence-gated execution slices with delegation, governance threads, and runtime snapshots for full traceability |
| 3 | **QA evaluation & loop** | Quality review items, evaluator versions, evidence submission, verdicts, and daily reports that guarantee mission completion quality |
| 4 | **Agent wiki** | A company knowledge base that agents consult to prevent repeating the same mistakes |
| 5 | **Guard rails** | Worktree rules, tool grants, permission groups, and execution policies that block unintended agent actions |
| 6 | **QA evaluation & evolution system** | Anchor examples, candidate run replay, and evaluator version promotion that make the QA system improve over time |
| 7 | **Tool registration & agent permissions** | Companies register tools (executable programs or external execution paths) and control which agents may invoke them |
| 8 | **Work products** | Formal storage of deliverables with work-product storage backed by S3-compatible or local object storage |

## The Problem

Work management software doesn't go far enough. When your workforce is AI agents, you need more than a to-do list — you need a **control plane** for an entire company that guarantees the work is done, done well, and done safely.

## What papercompany Does

papercompany is the command, coordination, governance, and quality layer for agent teams. It is the single place where you:

- **Manage agent teams** — hire, organize, and track who owns which kind of work
- **Define org structure** — make reporting lines and responsibilities explicit
- **Run missions end to end** — define workflow harnesses, execute mission slices, and trace every step
- **Guarantee output quality** — QA evaluation loops review work, request evidence, and gate completion
- **Prevent repeated mistakes** — the agent wiki carries institutional knowledge between runs
- **Control costs** — enforce budgets, monitor spend, and stop runaway execution
- **Govern autonomy** — approvals, guard rails, permission groups, and audit trails
- **Register tools safely** — companies define executable tools and grant agent access per permission

## Two Layers

### 1. Control Plane (papercompany)

The central nervous system. It manages company structure, missions, workflow harnesses, work tracking, QA evaluation, approvals, budgets, tools, work products, and execution visibility.

### 2. Paperclip base foundation

The open-source orchestration foundation underneath: org charts, issues, heartbeats, adapter invocation, secrets, and storage. Agents run through adapter runtimes such as Claude Code, Codex, Gemini, Command Code, shell processes, or HTTP webhooks, and report into the control plane.

papercompany does not replace the base systems. It orchestrates agent teams so work is completed through them in a governed, observable, and quality-assured way.

## The Eight Evolutions in Depth

### 1. Agent workflow harness

Paperclip base gives you tasks and heartbeats. papercompany adds an executable **workflow harness** — a DAG-based procedure that orchestrates missions end to end.

- Workflow definitions compose **tool steps** (execute directly, no issue) and **agent steps** (create or wake a step issue)
- Each run produces step runs with status, iteration index, and issue links
- The native workflow engine handles duplicate-run guards, conditional skips, rework/back-edges, and reconciliation of stuck runs
- Manual completion, step rerun, resume, and cancel are all first-class operations

See [Workflows](/api/workflows) and [Missions](/api/missions) in the API reference.

### 2. Mission-centered execution

Work is organized around **missions** — the "why" unit — rather than a flat task list.

- Missions carry goals, owner agents, and evidence-gated execution slices
- Delegations assign scoped work to agents with explicit instructions
- Governance threads, human-operator requests, and runtime snapshots make every mission auditable
- Recovery advice and supervision runs give operators a guided path when a mission stalls

See [Missions](/api/missions).

### 3. QA evaluation & loop

Mission completion quality is guaranteed by a **QA evaluation loop**, not left to chance.

- Review items bind a candidate run to an evaluator version
- Evaluators request evidence, agents submit it, and verdicts gate completion
- Daily reports summarize quality across the company
- Candidate runs can be replayed through the evaluator

See [Quality](/api/quality).

### 4. Agent wiki

Institutional knowledge lives in an **agent wiki** that agents consult before acting — preventing the same mistakes from recurring across runs and missions.

- Company-scoped wiki content is served to agents at runtime
- Combined with company instructions files (`AGENTS.md`), agents get consistent context on every wake

See [Agent Wiki](/api/agent-wiki) and [Company Instructions](/api/company-instructions).

### 5. Guard rails

Unintended agent actions are blocked by **guard rails** before they happen.

- Worktree rules constrain where agents can operate and how workspaces are isolated
- Worktree proposals require review and approval before workspace changes apply
- Tool grants control which tools workflows may invoke
- Permission groups and execution policies define what each actor can do

See [Worktree](/api/worktree) and [Access & Members](/api/access).

### 6. QA evaluation & evolution system

The QA system itself **improves over time**.

- Review items can be promoted to **anchor examples** that calibrate future evaluations
- Evaluator versions are versioned and promoted to active
- Candidate run replay lets you measure how a new evaluator would have scored past work

See [Quality](/api/quality) — the evaluator-version and anchor endpoints.

### 7. Tool registration & agent permissions

Companies register **tools** — executable programs or external execution paths — and control which agents may invoke them.

- Tool definitions carry a name, description, JSON schema, and command template
- Tools are scoped per company; the test endpoint validates them with sample arguments
- Workflow tool grants and agent permissions gate invocation per role and per company

See [Tool Definitions](/api/tool-definitions) and [Workflows](/api/workflows).

### 8. Work products

Deliverables are stored **formally** as work products, with external object storage support.

- Work products are created, updated, opened, and versioned against their issue
- Company data storage (S3-compatible or local) stores normalized source data
- Work-product storage (S3-compatible or local) stores generated artifacts
- Connectivity tests validate both storage backends at configuration time

See [Work Products](/api/issues) and [Data Storage](/api/data-storage).

## Core Principle

You should be able to look at papercompany and understand your company at a glance — who is doing what, what is blocked, what needs review, what it costs, and whether meaningful work is being completed with verified quality.
