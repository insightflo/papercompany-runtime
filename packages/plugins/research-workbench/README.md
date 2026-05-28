# Research Workbench Plugin

`insightflo.research-workbench` gives Papercompany Research Company agents a stable research/source tool without delegating reasoning to Vane's internal LLM agent loop.

## Tool

Runtime tool name:

```txt
insightflo.research-workbench:research-search
```

Agent-facing concept name:

```txt
research.search
```

## Boundary

Use this plugin as:

```txt
Research Company agent → research-search → papercompany-vane headless raw search → EvidenceBundle → agent synthesis
```

Do **not** treat Vane as the synthesizing research agent:

```txt
Papercompany agent → Vane researcher/writer/model loop → final answer
```

The Papercompany agent remains responsible for planning, query iteration, synthesis, claim mapping, and QA.

## Representative input

```json
{
  "query": "ItzCrazyKns Vane GitHub architecture API search SearxNG",
  "profile": "tech_scout",
  "sourceScope": ["web", "discussions"],
  "domainHints": ["github.com"],
  "excludeDomains": [],
  "freshness": "recent",
  "maxResults": 10
}
```

## Current MVP-B source scope

- `web`: supported; maps to Vane/SearXNG general search.
- `discussions`: best-effort; warn and fall back where unsupported.
- `academic`: reserved; warn unless backend mapping is explicitly verified.

## Failure behavior

The tool returns structured recoverable failures:

- validation/input failures: `ToolResult.error` with `data.retryable=false`
- upstream/backend failures: `ToolResult.error` with `data.retryable=true` and optional `retryAfterSeconds`

Workflow-engine should keep parent oversight issues blocked with diagnostics rather than cancelling the mission for retryable research backend failures.

## Verification

```bash
pnpm --filter @insightflo/paperclip-research-workbench test
pnpm --filter @insightflo/paperclip-research-workbench typecheck
```

When testing against a real Vane service, use the operations scaffold:

```bash
cd /Users/kwak/Projects/ai/papercompany/papercompany-operations/services/vane
./smoke-test.sh
```
