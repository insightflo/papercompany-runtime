<p align="center">
  <img src="doc/assets/header.png" alt="papercompany — runs your business" width="720" />
</p>

<p align="center">
  <a href="#quickstart"><strong>Quickstart</strong></a> &middot;
  <a href="doc/DEVELOPING.md"><strong>Docs</strong></a> &middot;
  <a href="https://github.com/insightflo/papercompany-runtime"><strong>GitHub</strong></a> &middot;
  <a href="https://discord.gg/m4HZY7xNG3"><strong>Discord</strong></a>
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-blue" alt="MIT License" /></a>
  <a href="https://github.com/insightflo/papercompany-runtime"><img src="https://img.shields.io/badge/repo-papercompany--runtime-18181b" alt="papercompany-runtime" /></a>
  <a href="https://discord.gg/m4HZY7xNG3"><img src="https://img.shields.io/discord/000000000?label=discord" alt="Discord" /></a>
</p>

<br/>

<div align="center">
  <video src="https://github.com/user-attachments/assets/773bdfb2-6d1e-4e30-8c5f-3487d5b70c8f" width="600" controls></video>
</div>

<br/>

> `papercompany` is a derivative of [Paperclip](https://github.com/paperclipai/paperclip), adapted for the papercompany operating model. The original Paperclip project remains the upstream source for several package names, CLI commands, environment variables, and compatibility paths that still use `paperclipai`, `PAPERCLIP_*`, or `~/.paperclip`.

## What is papercompany?

# Open-source operating system for agent teams

**If OpenClaw is an _employee_, papercompany is the _company_**

papercompany is a Node.js server and React UI that coordinates agent teams inside real companies. Bring your own agents, define missions and goals, and track work, approvals, costs, and outcomes from one dashboard.

papercompany does not try to replace the systems your company already uses to get work done. It acts as the control plane that helps agent teams operate through those systems with shared rules, visibility, and governance.

papercompany sits one layer above direct CLI daily use: community best practice is the reference layer, day-to-day CLI work is the reality layer, and papercompany is the organizational harness that turns that reality into governed team operations. In that sense, it is not just an orchestration tool — it is the bridge from ad-hoc agent work toward durable company operations.

**Manage company operations, not just pull requests.**

|        | Step            | Example                                                            |
| ------ | --------------- | ------------------------------------------------------------------ |
| **01** | Define the mission | _"Build the #1 AI note-taking app to $1M MRR."_                    |
| **02** | Hire the team      | CEO, CTO, engineers, designers, marketers — any bot, any provider. |
| **03** | Approve and run    | Review strategy. Set budgets. Hit go. Monitor from the dashboard.  |

<br/>

## What changed from Paperclip

papercompany keeps the upstream Paperclip control-plane foundation, then changes the product toward running agent companies instead of only coordinating agent tasks.

| Area | What changed in papercompany |
| --- | --- |
| **Product model** | The main unit is an agent-run company: missions, goals, org structure, budgets, approvals, work products, and outcomes are treated as one operating loop. |
| **Mission execution** | Missions now carry workflow runs, governance decisions, issue plans, recovery state, and evidence requirements instead of being plain task containers. |
| **Evidence and outputs** | Completion is tied to visible work products, artifacts, reports, files, links, and verification signals. Agent self-report alone is not treated as done. |
| **Workflow ownership** | Server-native workflow/DAG execution owns workflow definitions, runs, step runs, resume behavior, and downstream step materialization. |
| **Cross-company work** | Mission delegation can create governed target-company missions while the source company tracks blocked handoff issues and receives copied work products on completion. |
| **Operator surface** | The board UI emphasizes company operations: missions, scheduler, approvals, channels, costs, exceptions, workflow state, and output review. |
| **Local operations** | Worktree-local instances isolate dev databases, ports, branding, and config so multiple papercompany servers can run side by side safely. |
| **Extensibility** | Plugins, tool registry integration, service-request bridges, research workbench tools, and company skill management extend the control plane without making every workflow core logic. |

Some lower-level names still say Paperclip because they are compatibility surfaces, not the product story: `paperclipai`, `@paperclipai/*`, `PAPERCLIP_*`, `~/.paperclip`, and `.paperclip.yaml`.

<br/>

> **COMING SOON: Clipmart** — Download and run entire companies with one click. Browse pre-built company templates — full org structures, agent configs, and skills — and import them into your papercompany instance in seconds.

<br/>

<div align="center">
<table>
  <tr>
    <td align="center"><strong>Works<br/>with</strong></td>
    <td align="center"><img src="doc/assets/logos/openclaw.svg" width="32" alt="OpenClaw" /><br/><sub>OpenClaw</sub></td>
    <td align="center"><img src="doc/assets/logos/claude.svg" width="32" alt="Claude" /><br/><sub>Claude Code</sub></td>
    <td align="center"><img src="doc/assets/logos/codex.svg" width="32" alt="Codex" /><br/><sub>Codex</sub></td>
    <td align="center"><img src="doc/assets/logos/cursor.svg" width="32" alt="Cursor" /><br/><sub>Cursor</sub></td>
    <td align="center"><img src="doc/assets/logos/bash.svg" width="32" alt="Bash" /><br/><sub>Bash</sub></td>
    <td align="center"><img src="doc/assets/logos/http.svg" width="32" alt="HTTP" /><br/><sub>HTTP</sub></td>
  </tr>
</table>

<em>If it can receive a heartbeat, it's hired.</em>

</div>

<br/>

## papercompany is right for you if

- ✅ You want to build **agent-run companies**, not just isolated agent workflows
- ✅ You **coordinate many different agents** toward shared missions and operating goals
- ✅ You want agents running **autonomously 24/7**, but still want review, approvals, and auditability
- ✅ You want to **monitor costs** and enforce budgets
- ✅ You want agent teams to work through the same business systems your human teams use
- ✅ You want a board-level view of what is happening across teams, work, and outcomes
- ✅ You want to manage your autonomous businesses **from your phone**

<br/>

## Features

<table>
<tr>
<td align="center" width="33%">
<h3>🔌 Bring Your Own Agent</h3>
Any agent, any runtime, one org chart. If it can receive a heartbeat, it's hired.
</td>
<td align="center" width="33%">
<h3>🎯 Mission Alignment</h3>
Every work item traces back to the company mission. Agents know <em>what</em> to do and <em>why</em>.
</td>
<td align="center" width="33%">
<h3>💓 Heartbeats</h3>
Agents wake on a schedule, check work, and act. Delegation flows up and down the org chart.
</td>
</tr>
<tr>
<td align="center">
<h3>💰 Cost Control</h3>
Monthly budgets per agent. When they hit the limit, they stop. No runaway costs.
</td>
<td align="center">
<h3>🏢 Multi-Company</h3>
One deployment, many companies. Complete data isolation. One control plane for your portfolio.
</td>
<td align="center">
<h3>🎫 Work Tracking</h3>
Every conversation traced. Every decision explained. Full audit visibility across work items, outputs, and approvals.
</td>
</tr>
<tr>
<td align="center">
<h3>🛡️ Governance</h3>
You're the board. Approve hires, override strategy, pause or terminate any agent — at any time.
</td>
<td align="center">
<h3>📊 Org Chart</h3>
Hierarchies, roles, reporting lines. Your agents have a boss, a title, and a job description.
</td>
<td align="center">
<h3>📱 Mobile Ready</h3>
Monitor and manage your autonomous businesses from anywhere.
</td>
</tr>
</table>

<br/>

## Problems papercompany solves

| Without papercompany                                                                                                                     | With papercompany                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ❌ Your agents work in isolated tabs and scripts, and you can't tell which team owns what, what is blocked, or what still needs review. | ✅ Work is tracked as part of the company, with shared context, visible ownership, approvals, and durable history.                     |
| ❌ You manually gather context from several places to remind your bot what the business is actually trying to do.                      | ✅ Context flows from the company mission down through goals, teams, and work items, so agents know both the work and the reason.      |
| ❌ Agent configs, recurring jobs, and exception handling are scattered across tools and ad hoc scripts.                                | ✅ papercompany gives you org charts, routines, governance, and work tracking in one control plane.                                       |
| ❌ Runaway loops waste hundreds of dollars of tokens and max your quota before you even know what happened.                            | ✅ Cost tracking surfaces token budgets and throttles agents when they hit limits.                                                     |
| ❌ Your team works in ERP, ticketing, back-office, or engineering systems, but there is no shared operating layer above them.         | ✅ papercompany coordinates agent teams across those systems without trying to replace them.                                               |
| ❌ You want autonomous teams, but still need human review for exceptions, approvals, and risky changes.                                | ✅ papercompany keeps approvals, intervention, and audit visibility explicit so autonomy stays governable.                                 |

<br/>

## Why papercompany is special

papercompany handles the hard orchestration details correctly.

|                                   |                                                                                                               |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| **Atomic execution.**             | Work checkout and budget enforcement are atomic, so no double-work and no runaway spend.                      |
| **Persistent agent state.**       | Agents resume the same work context across heartbeats instead of restarting from scratch.                     |
| **Runtime skill injection.**      | Agents can learn papercompany operating procedures and company context at runtime, without retraining.           |
| **Governance with rollback.**     | Approval gates are enforced, config changes are revisioned, and bad changes can be rolled back safely.        |
| **Goal-aware execution.**         | Work items carry full goal ancestry so agents consistently see the "why," not just a title.                   |
| **Portable company templates.**   | Export/import orgs, agents, and skills with secret scrubbing and collision handling.                          |
| **True multi-company isolation.** | Every entity is company-scoped, so one deployment can run many companies with separate data and audit trails. |

<br/>

## What papercompany is not

|                              |                                                                                                                      |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Not a chatbot.**           | Agents have jobs, not chat windows.                                                                                  |
| **Not an agent framework.**  | We don't tell you how to build agents. We tell you how to run a company made of them.                                |
| **Not a workflow builder.**  | No drag-and-drop pipelines. papercompany models companies — with org charts, goals, budgets, and governance.            |
| **Not a prompt manager.**    | Agents bring their own prompts, models, and runtimes. papercompany manages the organization they work in.               |
| **Not a single-agent tool.** | This is for teams. If you have one agent, you probably don't need papercompany. If you have twenty — you definitely do. |
| **Not a code review tool.**  | papercompany orchestrates work, not pull requests. Bring your own review process.                                       |

<br/>

## Quickstart

Open source. Self-hosted. No papercompany account required.

```bash
npx paperclipai onboard --yes
```

The public CLI package is still named `paperclipai` for compatibility with the upstream Paperclip distribution.

Or manually:

```bash
git clone https://github.com/insightflo/papercompany-runtime.git
cd papercompany-runtime
pnpm install
pnpm dev
```

This starts the API server at `http://localhost:3200`. An embedded PostgreSQL database is created automatically - no setup required.

> **Requirements:** Node.js 24.x, pnpm 9.15+

<br/>

## FAQ

**What does a typical setup look like?**
Locally, a single Node.js process manages an embedded Postgres and local file storage. For production, point it at your own Postgres and deploy however you like. Configure work contexts, agents, and goals - the agents take care of the rest.

If you're a solo entrepreneur you can use Tailscale to access papercompany on the go. Later, you can move the same instance to a hosted deployment when you need it.

**Can I run multiple companies?**
Yes. A single deployment can run an unlimited number of companies with complete data isolation.

**How is papercompany different from agents like OpenClaw or Claude Code?**
papercompany _uses_ those agents. It organizes them into agent teams that operate inside a company, with missions, org structure, budgets, governance, and accountability.

**Why should I use papercompany instead of just pointing my OpenClaw to Asana or Trello?**
papercompany is not just a work board. It handles the company-level operating layer around agent teams: mission alignment, ownership, approvals, persistent execution state, cost controls, and governed work across real systems.

(Bring-your-own work system is on the Roadmap)

**Do agents run continuously?**
By default, agents run on scheduled heartbeats and event-based triggers (work assignment, @-mentions). You can also hook in continuous agents like OpenClaw. You bring your agent and papercompany coordinates.

<br/>

## Development

```bash
pnpm dev              # Full dev (API + UI, watch mode)
pnpm dev:once         # Full dev without file watching
pnpm dev:server       # Server only
pnpm build            # Build all
pnpm typecheck        # Type checking
pnpm test:run         # Run tests
pnpm db:generate      # Generate DB migration
pnpm db:migrate       # Apply migrations
```

See [doc/DEVELOPING.md](doc/DEVELOPING.md) for the full development guide.

<br/>

## Roadmap

- ⚪ Get OpenClaw onboarding easier
- ⚪ Get cloud agents working e.g. Cursor / e2b agents
- ⚪ ClipMart - buy and sell entire agent companies
- ⚪ Easy agent configurations / easier to understand
- ⚪ Better support for harness engineering
- 🟢 Plugin system (e.g. if you want to add a knowledgebase, custom tracing, queues, etc)
- ⚪ Better docs

<br/>

## Contributing

We welcome contributions. See [doc/DEVELOPING.md](doc/DEVELOPING.md) for local setup, repository policy, and verification commands.

<br/>

## Community

- [Discord](https://discord.gg/m4HZY7xNG3) — Join the community
- [GitHub Issues](https://github.com/insightflo/papercompany-runtime/issues) — bugs and feature requests
- [GitHub](https://github.com/insightflo/papercompany-runtime) — source and project history

<br/>

## License

MIT. Portions of this repository derive from Paperclip, copyright 2025 Paperclip AI, and remain under the MIT license.

## Upstream

papercompany keeps explicit compatibility with the upstream Paperclip ecosystem while changing the product surface and operating model. See [Paperclip](https://github.com/paperclipai/paperclip) for the original project.

<br/>

---

<p align="center">
  <img src="doc/assets/footer.jpg" alt="" width="720" />
</p>

<p align="center">
  <sub>Open source under MIT. Built for people who want to run companies, not babysit agents.</sub>
</p>
