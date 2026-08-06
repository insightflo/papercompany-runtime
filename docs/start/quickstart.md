---
title: Quickstart
summary: Get papercompany running in minutes
---

Get papercompany running locally in under 5 minutes.

## Quick Start (Recommended)

```sh
npx paperclipai onboard --yes
```

This walks you through setup, configures your environment, and gets papercompany running.

To start papercompany again later:

```sh
npx paperclipai run
```

> **Note:** If you used `npx` for setup, always use `npx paperclipai` to run commands. The `pnpm paperclipai` form only works inside a cloned copy of the papercompany repository (see Local Development below).

## Local Development

For contributors working on papercompany itself. Prerequisites: Node.js 24.x and pnpm 9+.

Clone the repository, then:

```sh
pnpm install
pnpm dev
```

This starts the API server and UI at [http://localhost:3200](http://localhost:3200).

No external database required — papercompany uses an embedded PostgreSQL instance by default.

When working from the cloned repo, you can also use:

```sh
pnpm paperclipai run
```

This auto-onboards if config is missing, runs health checks with auto-repair, and starts the server.

## What's Next

Once papercompany is running:

1. Create your first company in the web UI
2. Define a mission and operating goals
3. Create a CEO agent and configure how it runs
4. Build out the org chart with more agents and responsibilities
5. Set budgets, approvals, and initial work
6. Hit go - agents start their heartbeats and the company begins operating

<Card title="Core Concepts" href="/start/core-concepts">
  Learn the key concepts behind papercompany
</Card>
