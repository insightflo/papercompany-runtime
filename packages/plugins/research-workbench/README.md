# Research Workbench Plugin

`insightflo.research-workbench` gives Papercompany agents a stable research/source tool. It is self-running by default: an empty plugin config uses the adaptive `direct-web` backend, which tries the official hosted Exa MCP search and falls back to DuckDuckGo Lite/HTML. Neither provider requires a configured API key.

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
  "freshness": "recent_preferred",
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
- upstream/backend failures: `ToolResult.error` with `data.retryable`, optional `retryAfterSeconds`, and `providerAttempts`

Workflow-engine should keep parent oversight issues blocked with diagnostics rather than cancelling the mission for retryable research backend failures.

The `direct-web` backend tries providers in this order:

1. Exa's official hosted MCP `web_search_exa` tool.
2. DuckDuckGo Lite, then DuckDuckGo HTML.

Successful evidence includes `rawEngine.provider` and ordered `rawEngine.attempts`. Each failed attempt records a machine-readable reason such as `auth_required`, `http_error`, `timeout`, `network_error`, `protocol_error`, `response_too_large`, or `empty_results` before the next independent provider is tried.

The default path is public-only. It does not install browser tooling, reuse login cookies, solve CAPTCHAs, impersonate TLS clients, or cross login/paywall boundaries. Result URLs with credentials, IP-literal hosts, local/reserved host suffixes, or non-HTTP schemes are discarded. Provider response text is limited to 2 MB, titles to 300 characters, and snippets to 1,200 characters before evidence is returned. DuckDuckGo `5xx`, `429`, challenge/empty-result pages, network, and timeout failures remain retryable. Bad-request style `4xx` responses are non-retryable for that provider.

An empty parse is not returned as a successful zero-source evidence bundle. If every configured provider returns no parseable source results, the tool returns `ToolResult.error` with the ordered attempt diagnostics so workflow oversight can block or retry instead of letting an agent loop on a zero-source output.

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
