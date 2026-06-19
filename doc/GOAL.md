# papercompany

**papercompany is the operating system for agent teams.** We are building the infrastructure that lets AI workers operate inside real companies through the same regulated work systems human teams use to maintain consistency, compliance, and shared operational data.

This project is derived from the original [Paperclip](https://github.com/paperclipai/paperclip) codebase. The product direction, examples, and operating language in this repository are written for papercompany, while some runtime compatibility names still intentionally use Paperclip-era identifiers.

## The Vision

Autonomous companies will not be built by better chat windows alone.
They will be built by giving AI workers structure, procedures, governance, and access to the operational systems real companies already depend on.

papercompany is not the company.
papercompany is what makes AI-run companies possible.
We are the control plane, the nervous system, the operating layer.

A human accounting team uses an ERP.
A human support team uses a ticketing system.
A human operations team uses a back-office system.
A human engineering team uses repositories, CI, and deployment tooling.

papercompany does not replace those systems.
It coordinates agent teams so work is carried out through them, under company rules, with human oversight where needed.

The measure of our success is not whether one coding workflow works.
It is whether papercompany becomes the default operating layer for companies made of AI workers, across many kinds of teams and many kinds of regulated business work.

## The Problem

Work management software does not go far enough.
When your workforce is AI agents, you need more than a to-do list.

You need a system that can:

- organize agents into teams and reporting structures
- route work through company procedures
- make outputs happen in the correct work systems
- preserve shared operational data and formatting rules
- keep approvals, review, and exceptions explicit
- control budgets, risk, and auditability

Without that, agents can generate output, but they cannot reliably operate a company.

## What This Is

papercompany is the command, coordination, and governance layer for agent teams.
It is the place where you:

- **Define company missions and operating goals** - what the company is trying to achieve and why
- **Organize agent teams** - who owns which kind of work and who reports to whom
- **Route work through procedures** - how work should be carried out, reviewed, and completed
- **Complete outputs in real work systems** - where the final result must live to count as done
- **Manage approvals and exceptions** - what needs human review, intervention, or escalation
- **Control budgets and risk** - how autonomy stays safe, observable, and affordable
- **Observe outcomes** - what was completed, what is blocked, and what moved the business forward

## Architecture

Two layers:

### 1. Control Plane (this software)

The operating layer for the company. It manages:

- company structure and team responsibility
- missions, goals, and operating procedures
- work allocation and execution state
- approvals, review, and exceptions
- budget policy, risk control, and audit trails
- outcome visibility across the company

### 2. Work Systems (external systems)

These are the regulated systems where work is actually completed and recorded.
They enforce shared formats, required fields, state transitions, and durable business records.

Examples include:

- ERP and accounting systems
- CRM and ticketing systems
- back-office and operations tools
- repositories, CI, and deployment systems
- file, document, and submission systems

papercompany does not try to become every work system.
It orchestrates agent teams so work is completed through those systems in a governed, observable way.

## Core Principle

Work is not done when an agent produces text.
Work is done when the right work item has been carried through the right procedure, completed in the right work system, and verified at the right level of human oversight.
