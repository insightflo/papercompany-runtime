# Mission Operating Kernel

Status: design guardrail for Papercompany-specific mission execution
Date: 2026-06-04

Papercompany keeps the mission-first, self-healing, token-saving concept while avoiding bespoke, over-controlled agent logic.

## Core Identity

Papercompany is a mission-first operating system for agent teams.

Agents work through bounded missions, not open-ended chats. Completion requires evidence, not self-report. Failures become exceptions, and exceptions trigger a small recovery vocabulary. Memory is compact: rolling mission state plus handoffs, not full history replay. Humans operate the company: they set direction, approve risky actions, and resolve ambiguity.

## Non-Negotiable Concepts

1. **Mission first** — every issue, run, artifact, handoff, exception, and recovery action belongs to a mission when the work is mission-scoped.
2. **Evidence first** — done means status plus evidence references and verification signal. Agent self-report is useful but not authoritative.
3. **Bounded self-healing** — self-healing is exception detection plus one limited recovery action, not an expanding tree of special-case automation.
4. **Token-saving memory** — agents receive compact mission state, issue envelope, recent handoff refs, and do-not-repeat notes instead of full history replay.
5. **Operator control plane** — humans are not a step-by-step bottleneck; they handle side effects, budget/policy stops, ambiguity, and repeated failures.

## Small Exception Vocabulary

Core mission self-healing should classify problems into a small set:

- `failed_run`
- `blocked_issue`
- `stale_issue`
- `missing_evidence`
- `budget_or_policy_stop`

Domain-specific exceptions may exist in plugins or recipes, but core services should not grow role-specific branches for every workflow.

## Small Recovery Vocabulary

Core recovery actions are limited to:

- `retry_same_issue`
- `wake_current_assignee`
- `request_owner_decision`
- `mark_blocked`
- `abort_or_pause_mission`

Workflow-specific actions such as creating validator, synthesis, report, or publication issues belong in recipes/plugins, not in the mission kernel.

## Context Contract

Mission run context should be compiled from a short contract:

- mission objective/current phase
- current issue envelope
- rolling mission state
- recent handoff references
- required evidence and available artifact refs
- do-not-repeat notes
- stop conditions

Persistent CLI sessions are an adapter optimization. The core contract is whether a run needs full bootstrap context or issue-envelope-only context.

## Implementation Boundaries

Keep core services small:

- mission service owns mission lifecycle and company boundaries
- mission runtime manager owns runtime rows and terminal cleanup
- mission context compiler owns bootstrap-vs-envelope policy
- mission recovery policy owns exception/action vocabulary
- recipes/plugins own domain-specific workflow semantics

Avoid these patterns in core:

- role/title regexes that infer workflow meaning
- comment markers as authoritative state machines
- provider-specific CLI behavior leaking into mission logic
- bespoke recovery branches for each dogfood incident
- long, detailed agent instructions when a short envelope and evidence contract is enough
