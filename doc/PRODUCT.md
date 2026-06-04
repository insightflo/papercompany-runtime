# Paperclip - Product Definition

## What It Is

Paperclip is the control plane for agent-run company operations.
One instance of Paperclip can run multiple companies. A **company** is a first-order object.

Paperclip is designed so that coding is one department, not the center of the product.
Its purpose is to help agent teams operate more like human teams: through missions, procedures, approvals, regulated work systems, and visible outcomes.

## Core Concepts

### Company

A company has:

- **missions and goals** - what the company is trying to achieve and why
- **teams and reporting structure** - who owns which kind of work
- **procedures and operating rules** - how work should move through the business
- **work items** - the atomic units of action that advance a mission
- **work systems** - the regulated systems where work is actually completed and recorded
- **approvals, review, and policies** - how autonomy stays safe and governed
- **budgets and outcomes** - what work costs and what it accomplishes

### Teams and Agents

Paperclip organizes workers into teams with clear responsibilities.
Those teams may be engineering, accounting, operations, support, sales, or another business function.

In the current V1 implementation, live org structure is represented primarily through companies, agents, reporting lines, goals, missions, and issues.
That means **team** is already the right product noun, even though the current schema still expresses most of it through agent hierarchy rather than a dedicated teams model.

Each worker has:

- **role and reporting** - title, responsibility, and who they report to
- **capabilities** - what they are good at and when they should be involved
- **execution configuration** - how they run and what systems they can use
- **policies and limits** - budgets, approvals, permissions, and risk controls

### Missions and Goals

A mission is the business purpose a company or team is pursuing.
Goals provide the planning and alignment structure underneath that purpose.

In current V1 terms, **goals** remain the main planning object and **missions** are the newer board-facing operating object.
The product language should move toward missions, while staying honest that the implementation still uses both.

### Procedures

Work should not happen as free-form prompting alone.
It should flow through procedures: recurring rules, workflow steps, schedules, approvals, and system interactions.

In V1, procedures are expressed primarily through routines, workflows, schedules, and approvals.

### Work Items

A work item is the atomic unit of action in the company.
It exists in service of a mission and moves through a defined procedure.

In V1, work items are represented primarily as issues.
That makes **issue** an implementation noun, not the cleanest long-term product noun.

### Work Systems

Work systems are the regulated systems human teams already use to maintain consistency, shared formats, required fields, state transitions, and durable business records.

Examples include:

- ERP and accounting systems
- CRM and ticketing systems
- back-office operations systems
- repositories, CI, and deployment systems
- document, file, and submission systems

Paperclip does not replace these systems.
It coordinates agent teams so work is completed through them.

### Outcomes

Paperclip should track not only activity and spend, but the outputs and outcomes that matter to the company.

In V1, outcomes are currently represented most concretely through documents, work products, approvals, and visible artifacts rather than through a single dedicated outcome model.

## V1 Implementation Bridge

Paperclip's product language should evolve faster than its implementation vocabulary, but the bridge must stay explicit.

In V1:

- **work items** are primarily represented as issues
- **procedures** are primarily represented through routines, workflows, schedules, and approvals
- **outcomes** are primarily represented through documents and work products
- **work systems** are reached through execution infrastructure such as adapters and workspaces

This means the product should increasingly speak in company-operating terms, while the schema and API still use some V1 execution-oriented nouns.

## Principles

1. **Company is the unit of organization.** Everything lives under a company. One Paperclip instance, many companies.

2. **Agent teams should operate like human teams.** The product should model responsibility, procedure, approvals, and outcomes, not just execution.

3. **Work should flow through company procedures.** Free-form generation is not enough. Durable work must pass through the right systems and constraints.

4. **Outputs matter when they are completed in the right place.** Generated text is not the same thing as finished business work.

5. **Control plane, not execution plane.** Paperclip orchestrates. The actual work is carried out through external work systems and execution infrastructure.

6. **Mission operating kernel, not bespoke micromanagement.** Papercompany-specific autonomy should stay bounded by the concise mission-first/evidence-first/recovery-action contract in `doc/spec/mission-operating-kernel.md`.

7. **Budgets, approvals, and auditability are core features.** They are not optional enterprise add-ons.

## User Flow (Dream Scenario)

1. Open Paperclip and create a company
2. Define the company's mission and operating goals
3. Create the initial leadership and key team roles
4. Define which procedures and work systems those teams use
5. Set budgets, approvals, and operating constraints
6. Start the company - agents begin working through missions, procedures, and work systems
7. Observe outcomes, review exceptions, and intervene only where needed

## What Paperclip Should Do vs. Not Do

**Do**

- Stay **board-level and company-level**. Users should manage missions, goals, orgs, budgets, approvals, and outcomes.
- Make the first five minutes feel magical: install, answer a few questions, and see a team complete real work.
- Keep work anchored to **missions, work items, procedures, and outputs**, even if the surface feels conversational.
- Treat **agency / internal team / startup** as the same underlying abstraction with different templates and labels.
- Make outputs first-class: files, documents, reports, records, submissions, previews, links, and visible artifacts.
- Support multiple kinds of work systems, not just engineering workflows.
- Surface the live company control plane clearly: missions, scheduler, approvals, channels, costs, exceptions, and outputs should feel like first-class operational views.
- Use **plugins and extensions** for special-purpose surfaces rather than bloating the core control plane.

**Do not**

- Do not make the core product a general chat app.
- Do not assume every important workflow is a coding workflow.
- Do not confuse generated output with completed work.
- Do not make adapter/workspace/runtime vocabulary the product identity.
- Do not force users to understand provider plumbing unless absolutely necessary.

## Specific Design Goals

1. **Time-to-first-success under 5 minutes**
   A fresh user should go from install to a team completing meaningful work in one sitting.

2. **Board-level abstraction always wins**
   The default UI should answer: what is the company doing, who is doing it, why does it matter, what did it cost, what is blocked, and what needs review.

3. **Conversation stays attached to work**
   Discussion should resolve to missions, procedures, work items, approvals, and outputs.

4. **Progressive disclosure**
   Top layer: human-readable summary. Middle layer: steps, artifacts, approvals, outputs. Bottom layer: raw logs, tool calls, and transcripts.

5. **Output-first**
   Work is not done until the user can see the result in the right form and in the right place.

6. **Local-first, cloud-ready**
   The mental model should not change between local solo use and shared/private or public/cloud deployment.

7. **Safe autonomy**
   Auto mode is allowed; hidden spend, silent failures, and invisible exceptions are not.

8. **Thin core, rich edges**
   Keep the core focused on operating the company. Push specialized surfaces into plugins and extensions.

## Further Detail

See [SPEC.md](./SPEC.md) for the long-horizon technical specification and [SPEC-implementation.md](./SPEC-implementation.md) for the current V1 implementation contract.
