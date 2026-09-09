# Workflow tool progress and deadlines

Audience: tool authors and operators. Purpose: opt in a producer that can measure real work, then diagnose idle or total-duration failures. This guide does not enable tools, change registry entries, or start workflows.

**Enable progress only after the producer implements the protocol.** The runtime extends an idle deadline only when a machine event advances a declared work counter. Logs, elapsed time, repeated counts, and reaching 100% do not complete a tool or workflow step.

## Modes and limits

- Without `adapterConfig.progress`, builtin and HTTP tools keep fixed-timeout behavior. HTTP defaults to 120000ms, retains a 1000ms minimum, and supports configured durations through 2147483647ms without the former five-minute clamp. Invalid, non-positive, non-numeric, or overflowing HTTP durations fail configuration validation. The deadline covers the response body as well as headers.
- With progress enabled, one invocation gets a new execution UUID and a DB-frozen policy. The earlier of `lastProgressAt + idleTimeoutMs` and `startedAt + maxDurationMs` wins. Receiving progress cannot extend the total-duration limit.
- The monitor checks DB state at intervals of at most 1000ms and uses a separate total timer. Expiry decisions use the DB clock. Response latency also includes polling and cleanup; the configured deadline is not an exact response-time promise.
- DB failures fail closed. A failed insert prevents dispatch. Failed acceptance/audit writes roll back together. A failed final write cannot turn into success, and an unavailable DB may leave an active-looking diagnostic row.
- MCP and plugin-dispatched tools do not gain this protocol. Synchronous `tool_json` condition calls disable progress and keep their fixed 30-second deadline. Board HTTP tool tests create an unscoped progress row.

## Explicit opt-in

Add only the `progress` object to an existing authorized builtin or HTTP configuration:

```json
{
  "progress": {
    "version": 1,
    "idleTimeoutMs": 10000,
    "maxDurationMs": 900000,
    "stages": [
      { "key": "copy", "unit": "bytes" }
    ]
  }
}
```

Use `process` / `items` for the HTTP example below. Units are `bytes`, `items`, `frames`, or `milliseconds`; choose a count your producer actually measures. `milliseconds` means completed work units, not wall-clock time spent waiting. Declare 1–32 unique ordered stages, using lowercase keys matching `[a-z][a-z0-9_-]{0,63}`. Both deadlines must be integer milliseconds from 1000 through 2147483647, with idle no greater than total.

The server persists at most one advance per 1000ms, except the first advance, which is eligible immediately. **Use idleTimeoutMs >= 10000 for integrations** and leave room for DB/network delay. After completing more work, report the latest cumulative count at the next eligible opportunity. Do not send a delayed heartbeat from a timer when no work happened. A short job can finish with its final counter ahead of the last persisted progress event.

## Event contract

One strict version-1 event, without timestamp, prose, or completion fields:

```json
{
  "version": 1,
  "executionId": "00000000-0000-4000-8000-000000000001",
  "sequence": 1,
  "stage": "copy",
  "unit": "bytes",
  "current": 65536,
  "total": 1048576
}
```

The example UUID is a placeholder; use the invocation's supplied identity.

- `sequence` must be a positive safe integer and exceed the last accepted sequence. `current` and optional `total` must be nonnegative safe integers; supplied total must be positive and at least current.
- Start at the first declared stage with current > 0. In the same stage, current must increase. Advance only to the next declared stage, with current > 0 and the declared unit. Skipped, backwards, unknown, or unit-changing stages do not extend idle.
- A stage may start without total and introduce it once. After introduction, do not change or omit it. The next stage resets its counter and total. Completing the final total is not a success signal.
- Duplicate/out-of-order sequence or non-advancing counters return `accepted:false, reason:no_progress` without row or audit writes. Throttled advances return `accepted:false, reason:throttled`; the sequence is not consumed. Subsequent real work may reuse that sequence or send a larger one.
- Bound each HTTP body and each local newline-delimited record to 4KiB. Reject malformed JSON, invalid UTF-8 on fd3, partial final fd3 records, or extra fields. The local producer must terminate records with a newline.

## Local builtin producer

The runtime supplies these reserved variables after user/step environment values:

- `PAPERCOMPANY_TOOL_EXECUTION_ID`: this invocation's execution UUID.
- `PAPERCOMPANY_TOOL_PROGRESS_FD=3`: write newline-delimited JSON to file descriptor 3, a separate machine channel.

Keep stdout for the final JSON/text result and stderr for diagnostics. Neither stream resets idle. A nonzero exit is failure even if progress was accepted. Output buffers remain capped at 10MiB per stdout/stderr stream.

On failure/abort, the runtime sends SIGTERM to its owned child and escalates to SIGKILL after two seconds only if that child has not exited. Once the owned child exits, failure cleanup closes this invocation's readable pipes, even if a descendant retains descriptors. Normal successful exits drain output and fd3 before returning. **Descendants may continue running; the runtime does not search for or kill descendant/process-group PIDs.**

Executable byte-copy example: [`local-copy.mjs`](../../scripts/examples/tool-progress/local-copy.mjs). It takes explicit `--input` and `--output` paths, requires a nonempty stable regular input, refuses to overwrite an existing output, and reports only bytes actually written. Failure can leave a partial output; inspect/remove that exact fixture file before retrying.

For a saved builtin tool, use an absolute command such as `/absolute/path/to/node /absolute/path/to/local-copy.mjs`, the byte policy above, and arguments `{ "input": "/explicit/input.bin", "output": "/explicit/new-copy.bin" }`. Do not enable the sample in a shared registry as part of a smoke test.

Standalone local smoke, without a runtime or DB:

```sh
work=$(mktemp -d)
printf 'real file bytes\n' > "$work/input.bin"
PAPERCOMPANY_TOOL_EXECUTION_ID=00000000-0000-4000-8000-000000000001 \
PAPERCOMPANY_TOOL_PROGRESS_FD=3 \
node scripts/examples/tool-progress/local-copy.mjs \
  --input "$work/input.bin" --output "$work/output.bin" 3>"$work/progress.ndjson"
cmp "$work/input.bin" "$work/output.bin"
```

## HTTP producer and dedicated callback capability

Operators must set the runtime's **trusted** `PAPERCLIP_PUBLIC_URL` to an absolute HTTPS base reachable from the tool service. Credentials, query, and fragment are forbidden. The runtime does not derive it from an incoming Host header or tool arguments. Missing/invalid callback configuration fails before dispatch.

Explicitly injected `callbackBaseUrl` in local tests may use loopback HTTP (`127.0.0.1`, `localhost`, or `::1`). This is a test dependency, not permission to set an insecure production `PAPERCLIP_PUBLIC_URL`. An example's local HTTP tool endpoint separately needs the existing `allowInsecureUrl:true` opt-in.

The outbound tool POST includes:

```text
X-Papercompany-Progress-Version: 1
X-Papercompany-Execution-Id: <execution UUID>
X-Papercompany-Progress-Url: <trusted base>/api/companies/<company UUID>/tool-executions/<execution UUID>/progress
X-Papercompany-Progress-Token: <per-execution capability>
```

POST the event to the exact supplied progress URL with `Content-Type: application/json` and the dedicated `X-Papercompany-Progress-Token` header. Keep the original tool request open until returning the configured final result envelope. The runtime rejects redirects in progress mode so it does not forward the capability to another endpoint.

The callback capability is 32 random bytes, stored only as a SHA-256 hash, and bound to company + execution + lifetime. Do not log the token, place it in a query string, put it in artifacts, or return it in the final envelope. Board access and agent API keys are not substitutes, including local-trusted implicit board access. Existing authentication and board mutation guards still apply; this is not a global authentication bypass.

| Callback response | Producer action |
| --- | --- |
| 200 `{ "accepted": true }` | Continue real work. |
| 200 `{ "accepted": false, "reason": "throttled" }` | Coalesce until later real work; do not queue a fake heartbeat. |
| 200 `{ "accepted": false, "reason": "no_progress" }` | Inspect counters/stages/order; this did not extend idle. |
| 400 `tool_progress_invalid_event` | Fix event shape/size; no raw body is echoed. Global malformed or >10MiB parser failures at this POST path also map to this bounded error. |
| 401 / 404 | Invalid capability or company/execution identity; stop this report attempt. |
| 409 | Terminal, expired, or replaced scope; stop reporting this invocation. |
| Other non-2xx / network failure | Treat progress delivery as failed; do not assume idle was extended. |

Executable item-processing example: [`http-items.mjs`](../../scripts/examples/tool-progress/http-items.mjs). It hashes explicit bounded `items` strings, accepts no file paths, checks the callback origin/base and execution identity, rejects callback redirects and non-2xx, and returns fixed errors without echoing tokens. It binds only to loopback. This is a teaching fixture, not a deployable public service.

```sh
# Set EXAMPLE_TOOL_AUTH_TOKEN through your secret/environment mechanism.
EXAMPLE_CALLBACK_BASE_URL=https://your-trusted-runtime.example \
PORT=8088 node scripts/examples/tool-progress/http-items.mjs
```

Use POST `/tool` with `Authorization` equal to `EXAMPLE_TOOL_AUTH_TOKEN`, input `{ "items": ["alpha", "beta"] }`, HTTP response configuration `{ "resultField": "result" }`, and progress stages `[{ "key": "process", "unit": "items" }]`. The configured tool auth secret and the per-invocation progress capability are different credentials. The fixture reports only after hashing an item; it has no free-running progress timer.

Run both examples' isolated smoke tests with Node 24:

```sh
node --test scripts/examples/tool-progress/smoke.test.mjs
```

These tests prove local byte equality, real item hashes, fd3/callback identity, fixed failure responses, and capability non-echo. Their callback receiver is a local fixture, not the runtime DB. Real DB/middleware/adapter integration lives in `server/src/__tests__/tool-progress-*.test.ts`.

## Diagnose without reading secrets

Set a company UUID in your SQL client's `company_id` variable; query only that company. Do not use `SELECT *`, select `token_hash`, or dump callback request headers.

```sql
SELECT id, tool_id, request_id, adapter_type,
       workflow_run_id, step_run_id, step_id,
       execution_generation, retry_count, iteration_index,
       state, reason, sequence, stage_index, current, total,
       started_at, last_progress_at, finished_at,
       LEAST(last_progress_at + (policy->>'idleTimeoutMs')::double precision * interval '1 millisecond',
             started_at + (policy->>'maxDurationMs')::double precision * interval '1 millisecond') AS deadline
FROM tool_execution_heartbeats
WHERE company_id = :'company_id'::uuid
ORDER BY started_at DESC
LIMIT 50;

SELECT created_at, action, entity_id, details
FROM activity_log
WHERE company_id = :'company_id'::uuid
  AND actor_type = 'system' AND actor_id = 'tool-progress'
  AND entity_type = 'tool_execution_heartbeat'
ORDER BY created_at DESC
LIMIT 100;
```

`tool_progress_idle_timeout` means no accepted persisted advance arrived before idle expiry. `tool_progress_max_timeout` means the frozen total duration expired. `tool_progress_scope_replaced` means the bound run/step lifetime no longer matches: generation, retry, iteration, or terminal parent/step changed. Check `started`, `advanced`, and terminal activity entries rather than stdout keywords. The runtime records those activity entries atomically with state updates.

An active row does not prove a process is alive or work was dispatched. A succeeded tool row does not authorize workflow completion or a downstream step. Existing final-result validation and the native workflow engine retain those responsibilities. Invalid final HTTP envelopes/assertions fail even with healthy progress; assertion failures may retain raw artifact evidence under the existing artifact contract.

## Rollback and rollout boundaries

Remove `adapterConfig.progress` for **future** invocations to restore fixed mode. The policy in an existing row remains frozen; editing configuration does not extend or change that invocation. Do not delete diagnostic rows or manually advance counters to revive a timed-out attempt.

Existing opaque producers require explicit protocol migration before opt-in. This change does not retrofit progress into blocking subprocess wrappers or already-registered services. No automatic retry, scheduler change, or workflow launch is part of this protocol.

Timeout aborts the local wait and prevents late abort-ignoring responses from publishing success artifacts. Remote work and descendant processes may continue after the adapter returns failure. Verify/cancel remote work through the producer's own supported controls; do not infer cancellation from a DB status or timeout response.
