---
title: Writing a Skill
summary: SKILL.md format and best practices
---

Skills are reusable instructions that agents can invoke during their heartbeats. They're markdown files that teach agents how to perform specific tasks.

## Skill Structure

A skill is a directory containing a `SKILL.md` file with YAML frontmatter:

```
skills/
└── my-skill/
    ├── SKILL.md          # Main skill document
    └── references/       # Optional supporting files
        └── examples.md
```

## SKILL.md Format

```markdown
---
name: my-skill
description: >
  Short description of what this skill does and when to use it.
  This acts as routing logic — the agent reads this to decide
  whether to load the full skill content.
---

# My Skill

Detailed instructions for the agent...
```

### Frontmatter Fields

- **name** — unique identifier for the skill (kebab-case)
- **description** — routing description that tells the agent when to use this skill. Write it as decision logic, not marketing copy.

## How Skills Work at Runtime

1. Agent sees skill metadata (name + description) in its context
2. Agent decides whether the skill is relevant to its current task
3. If relevant, agent loads the full SKILL.md content
4. Agent follows the instructions in the skill

This keeps the base prompt small — full skill content is only loaded on demand.

## Best Practices

- **Write descriptions as routing logic** — include "use when" and "don't use when" guidance
- **Be specific and actionable** — agents should be able to follow skills without ambiguity
- **Include code examples** — concrete API calls and command examples are more reliable than prose
- **Keep skills focused** — one skill per concern; don't combine unrelated procedures
- **Reference files sparingly** — put supporting detail in `references/` rather than bloating the main SKILL.md

## Skill Injection

Adapters are responsible for making skills discoverable to their agent runtime. The `claude_local` adapter uses a temp directory with symlinks and `--add-dir`. The `codex_local` adapter uses the global skills directory. See the [Creating an Adapter](/adapters/creating-an-adapter) guide for details.

## Improving Skills From Evidence

Paperclip agents should treat skills as trainable operating assets, but not as unchecked self-editing memory. Use the SkillOpt-lite self-improvement loop when repeated work shows that a skill, rule, KB entry, workflow, or role harness should change. The default patch shape is a bounded add/delete/replace proposal, not a broad rewrite.

### Inputs

Collect rollout evidence before proposing an edit:

- issue comments and closeouts,
- run logs and tool output,
- tests, API/DB readbacks, screenshots, or generated artifacts,
- validator PASS / REQUEST_CHANGES / BLOCKED rationale,
- user corrections.

Do not use a single anecdote as enough evidence unless the correction is explicit and durable.

### Patch proposal format

Keep edits bounded and reviewable:

```md
Self-improvement candidate:
- Asset: <skill | rule | KB | workflow | role harness>
- Evidence source: <links/issue/run/log/test/screenshot/user correction>
- Current failure or success pattern: <reusable behavior>
- Proposed bounded edit: <add/delete/replace, exact section>
- Validation plan: <reference task/check/test/readback>
- Rejected-edit note: <if a similar edit failed before>
- Gate owner: <agent/peer validator responsible for automatic validation>
- Auto-adoption result: <accepted | rejected | queued_for_validation | repair_needed>
```

### Gate

Accept the patch automatically when an agent validator or peer gate can compare before/after evidence or approve the bounded edit against a reference task. This is an automated validation gate: agent-gated adoption, not a user approval workflow; do not wait for user approval for bounded internal skill/rule/KB/workflow/role-harness adoption. If validation fails, keep the rejected-edit note with the reason so future agents do not retry the same ineffective instruction. If validation evidence is unavailable, queue a validation/repair slice instead of asking the user to decide.

### What not to promote

Do not add stale status to skills: PR numbers, issue IDs, commit hashes, one-off logs, temporary workarounds, or session summaries. Those belong in issue history, not reusable skills.
