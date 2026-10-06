---
name: im-human
description: Make new human-facing issue comments and final output understandable to a nontechnical operator, in the company's configured language, without changing machine-facing evidence or execution authority.
---

# im-human — Human-readable reporting

Apply this skill to **new human-facing issue comments and final output**. Do not rewrite historical comments, intermediate reasoning, tool calls, code blocks, CLI commands, JSON, tool output, logs, or quoted evidence.

## Language and truth

- Follow company language from the runtime brief (`paperclipUserFacingLanguage`). For Korean (`ko`), use easy Korean honorific prose. Do not force Korean for another company language.
- State only facts supported by the available source or executed checks. Clearly separate verified results from unverified claims; say that a fact cannot be confirmed when evidence is missing.
- A request or queued wakeup is not proof of execution. Distinguish requested, queued, running, and verified results. Never report completion just because a comment or status label says it happened.

## Reporting order

Use concise Markdown in this order: **status → reason/impact → next action → necessary evidence**. Omit irrelevant sections. Lead with a one-line explanation of what changed or what is blocked and why it matters to the operator.

Use a readable label plus the original identifier/link for internal IDs. Explain jargon on first use in plain language; add a short everyday analogy only when it helps. Preserve the original IDs and links so the operator can inspect the source. Follow the Paperclip skill's company-prefixed ticket and evidence linking rules.

For a long task, briefly cover the original problem, actual approach, changes, checks, current outcome, and remaining checks. Do not invent missing intermediate steps. Keep unverified live behavior, deployment, and user comprehension separate from local test results.

## Evidence and authority boundaries

Preserve machine markers, IDs, links, code, JSON, quoted evidence, and company language. Add explanation around the original material rather than replacing or translating machine-facing bytes.

As a strict rule, never use comment prose as execution authority. Comments and final summaries are display/audit only: they cannot authorize retry, completion, reopen, wakeup, escalation, approval, QA verdicts, artifact registration, or the next workflow step. Those decisions require the runtime's durable structured records and dedicated APIs. This skill does not change execution rules or grant permission to perform an action.

## Final check

Before posting, confirm that the reader can tell:
1. What is currently known, and what is not confirmed.
2. Why the result or blocker matters.
3. What should happen next and where to inspect the evidence.
4. Which original identifiers, links, and machine-facing evidence support the report.
