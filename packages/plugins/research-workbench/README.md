# Research Workbench Plugin

`insightflo.research-workbench` gives Papercompany Research Company agents a stable research/source tool. It is self-running by default: an empty plugin config uses the built-in `direct-web` backend, which performs keyless web search through DuckDuckGo Lite with DuckDuckGo HTML fallback and returns structured evidence bundles.

## Tool

Runtime tool name:

```txt
insightflo.research-workbench:research-search
```

Agent-facing concept name:

```txt
research.search
```

Workflow agents should use this tool when a step needs web search, source discovery, current external facts, or research collection. The Papercompany runtime exposes the namespaced tool above as the default workflow search tool when the plugin is ready; agent prompts receive the HTTP invocation contract for `/plugins/tools/execute` with `query` and optional `maxResults` parameters.

## Boundary

Use the default plugin as:

```txt
Research Company agent → research-search → direct-web raw search → EvidenceBundle → agent synthesis
```

Optional Vane mode is still available for deployments that run the Papercompany Vane headless service:

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

## Backend config

No config is required for the default backend:

```json
{}
```

That is equivalent to:

```json
{
  "backend": "direct-web",
  "defaultMaxResults": 5,
  "timeoutMs": 15000
}
```

Optional Vane backend:

```json
{
  "backend": "vane-headless",
  "vaneBaseUrl": "http://127.0.0.1:3310",
  "defaultMaxResults": 5,
  "timeoutMs": 15000
}
```

Optional script backend:

```json
{
  "backend": "script",
  "scriptCommand": "node /opt/research/search.js",
  "scriptWorkingDirectory": "/opt/research",
  "defaultMaxResults": 5,
  "timeoutMs": 15000
}
```

The script backend receives JSON on stdin and must print JSON search results on stdout. It is for custom deployments; it is not required for normal operation.

## Current MVP-B source scope

- `web`: supported by `direct-web`, `vane-headless`, and `script`.
- `discussions`: best-effort. `direct-web` warns and falls back to general web search; Vane/script support depends on the configured backend.
- `academic`: reserved; warn unless backend mapping is explicitly verified.

## Failure behavior

The tool returns structured recoverable failures:

- validation/input failures: `ToolResult.error` with `data.retryable=false`
- upstream/backend failures: `ToolResult.error` with `data.retryable=true` and optional `retryAfterSeconds`

Workflow-engine should keep parent oversight issues blocked with diagnostics rather than cancelling the mission for retryable research backend failures.

The `direct-web` backend sends explicit HTML request headers because some hosts return challenge/accepted pages to default Node fetch traffic. It first tries DuckDuckGo Lite and then falls back to DuckDuckGo HTML. DuckDuckGo `5xx`, `429`, challenge/empty-result pages, network, and timeout failures are retryable. Bad request style `4xx` responses are non-retryable.

An empty parse is not returned as a successful zero-source evidence bundle. If both DuckDuckGo surfaces return no parseable source results, the tool returns a retryable `ToolResult.error` so workflow oversight can block or retry with diagnostics instead of letting an agent loop on low-quality zero-source output.

## Verification

```bash
pnpm --filter @insightflo/paperclip-research-workbench test
pnpm --filter @insightflo/paperclip-research-workbench typecheck
pnpm --filter @insightflo/paperclip-research-workbench build
```

When testing against a real Vane service, use the operations scaffold:

```bash
cd /Users/kwak/Projects/ai/papercompany/papercompany-operations/services/vane
./smoke-test.sh
```
