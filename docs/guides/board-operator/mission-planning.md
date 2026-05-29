---
title: Mission Planning
summary: Plan missions as evidence-gated execution slices
---

Missions are outcome boundaries. A mission plan should not be a hidden prompt, a long task list, or a request for agents to "try everything." It should state the invariant that must hold, the slice currently being tested, the evidence required for PASS, and what should be promoted into reusable operating assets.

## Dynamic workflow operating model

In Paperclip, dynamic workflow means **uncertainty reduction with gates**, not simply "use more subagents" or "run everything in parallel."

Use the mission owner or lead agent as a controller:

```text
mission invariant
  -> scope hypothesis
  -> bounded execution slice
  -> worker/agent/tool output with evidence
  -> validator gate
  -> promote reusable learning or choose the next slice
```

The controller should plan, delegate, review, mediate, and decide the next scope. It should not absorb every source-gathering, production, validation, and delivery task itself unless the mission is intentionally trivial.

## Mission plan blocks

Include these blocks in mission plans, planning issues, or parent issues before execution begins.

```md
## Mission Invariant
- Product, safety, operational, and taste principles that must remain true for this mission.
- Example: Do not over-constrain with RPA-style hard rules when rule/KB/workflow assets are only judgment harnesses.
- Example: Report slice completion separately from end-to-end completion.

## Scope Hypothesis
- One sentence: this slice will prove, disprove, or unblock <specific uncertainty>.

## Execution Slice
- In scope: the exact workflow, issue, file set, config rows, or artifact this slice may touch.
- Out of scope: code/runtime/schema/deploy/push/external publish/side effects unless explicitly approved.
- Split by invariant, evidence, uncertainty, and ownership first; split by file path only when that is the true boundary.

## Evidence Required
- List concrete evidence required before PASS: diff, API response, DB/config readback, test output, screenshot, logs, generated artifact, user-flow proof, or peer review.
- ACKs and self-reported completion are not evidence by themselves.

## Gate
- PASS: required evidence is present and mission invariant still holds.
- REQUEST_CHANGES: evidence is missing, scope drifted, or the worker produced unverifiable output.
- BLOCKED: required input, approval, tool access, or runtime capability is unavailable.
- Name the validator or gate owner and the next-scope promotion condition.

## Promotion / Asset Update
- Promote reusable decisions into workflow, tool config, rule, KB, role harness, or skill only when the judgment will repeat.
- Do not promote stale session outcomes, PR numbers, issue IDs, commit hashes, one-off logs, or temporary status.
```

## Child issue / worker prompt contract

Every delegated child issue or worker prompt should say what evidence must come back:

```md
Objective:
- <bounded outcome>

Mission invariant:
- <principles that must not be broken>

Scope hypothesis:
- This slice tests/unblocks <uncertainty>.

In scope:
- <allowed edits/actions>

Out of scope:
- <forbidden edits/actions/side effects>

Evidence required for closeout:
- <commands, file paths, screenshots, API/DB readbacks, logs, tests, artifact paths>

Gate expectation:
- Return PASS-ready evidence, or REQUEST_CHANGES/BLOCKED with exact missing evidence.
```

## When not to split

Do not split work just to create more agents. Keep a slice together when:

- a single cross-file invariant must be held in one judgment,
- the task is mainly product/taste judgment,
- interfaces are unstable and exploration is still defining the problem,
- the mission owner lacks enough context to write evidence requirements,
- a split would make validation weaker than a single focused worker.

## SkillOpt-lite self-improvement loop

Use SkillOpt as an operating pattern, not as permission for agents to rewrite their own instructions unchecked. Paperclip agents should improve company skills, rules, KB, workflows, or role harnesses through bounded evidence-gated proposals:

```text
rollout evidence
  -> reflection on reusable failure/success patterns
  -> bounded add/delete/replace proposal
  -> automated validation gate against held-out or reference tasks
  -> agent-gated accept into an asset, reject with negative feedback, or queue for repair
  -> periodic slow/meta review for durable patterns
```

Paperclip mapping:

- **Rollout evidence**: issue threads, run logs, test output, API/DB readbacks, screenshots, artifacts, validator comments, and user corrections.
- **Reflection**: the lead or validator names the recurring behavior that should change; avoid example-specific fixes.
- **Bounded patch**: propose small add/delete/replace edits to one asset at a time. Do not rewrite a whole skill or role harness unless the gate explicitly requests it.
- **Validation gate**: compare before/after on reference tasks, focused tests, or checklist evidence. A plausible patch is not accepted until evidence improves and an agent validator or peer gate passes it. Do not route bounded internal asset adoption through a user-approval wait.
- **Rejected-edit buffer**: record rejected-edit proposals and why they failed so future agents do not repeat them.
- **Slow/meta update**: after repeated missions, summarize stable patterns separately from the deployed skill so training memory does not bloat runtime instructions.

A self-improvement candidate must include:

```md
Self-improvement candidate:
- Asset: <skill | rule | KB | workflow | role harness>
- Evidence source: <issue/run/test/screenshot/user correction>
- Proposed bounded edit: <add/delete/replace, exact section>
- Validation plan: <reference task/check/test/readback>
- Rejected-edit note: <if this was tried and failed before>
- Gate owner: <agent/peer validator responsible for automatic validation>
- Auto-adoption result: <accepted | rejected | queued_for_validation | repair_needed>
```

Agents may propose these candidates during closeout. For bounded internal asset updates, adoption should be automatic once evidence, bounded patch, and validation gate pass; do not wait for user approval. Agents still must not silently mutate skills, rules, KB, workflow definitions, role harnesses, publish targets, or adapter configuration outside the current issue scope or without an agent/peer gate verdict. External side effects such as push, deploy, publish, credentials, or destructive cleanup remain outside this automatic adoption path.

## Reporting rule

Always report:

- `slice complete` vs `end-to-end complete`,
- evidence checked,
- gate verdict,
- next scope or blocker,
- whether any reusable asset was promoted,
- whether any self-improvement candidate was accepted, rejected, or queued for validation.

Do not mark a mission complete because all child agents said "done." The gate owner must inspect evidence and confirm that the mission invariant still holds.
