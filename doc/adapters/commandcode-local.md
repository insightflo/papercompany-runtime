# Command Code (local) adapter

`commandcode_local` runs the [Command Code](https://commandcode.ai) CLI (`cmd` v1.7.0)
locally as a papercompany agent runtime. It executes headless, non-interactive
runs and parses the machine-readable NDJSON output.

## Requirements

- The `cmd` CLI is installed and on `PATH` (verify with `cmd --version`).
- Command Code is authenticated on the host (`cmd status` / `cmd login`).
- The model you select is available (`cmd --list-models`).

## Selecting the adapter

Choose **Command Code (local)** when creating or editing an agent. The default
executable is `cmd`; override it with the **Command** field if your binary lives
elsewhere or is named differently.

## Configuration

| Field | Description |
| --- | --- |
| `command` | Executable to invoke. Defaults to `cmd`. |
| `cwd` | Default working directory fallback (created if missing). |
| `instructionsFilePath` | Markdown instructions file folded into the run prompt. |
| `promptTemplate` | User prompt template sent via `-p`. |
| `model` | Model id from `cmd --list-models` (optional). |
| `effort` | Reasoning effort: `low`, `medium`, or `high`. |
| `maxTurns` | Passes `--max-turns` when greater than 0. Unset by default. |
| `env` | Extra `KEY=VALUE` environment variables (secrets redacted in logs). |
| `extraArgs` | Additional CLI flags inserted before `-p`. |
| `timeoutSec` / `graceSec` | Run timeout and SIGTERM grace period. |

## How it runs

Paperclip invokes Command Code in non-interactive print mode with
machine-readable output:

```
cmd -p <prompt> --output-format json --skip-onboarding \
  --permission-mode auto-accept --trust --no-auto-update \
  [--model <id>] [--effort <level>] [--max-turns <n>] [--resume <sessionId>]
```

- `--skip-onboarding`, `--permission-mode auto-accept`, `--trust`, and
  `--no-auto-update` are always applied so managed runs do not block on prompts
  or trigger background updates.
- Agent instructions and the runtime brief are folded into the single `-p`
  prompt (Command Code print mode takes one user message).

## Output handling

`cmd -p --output-format json` emits a documented NDJSON stream: one
`{"type":"event","event":{...AgentEvent...}}` frame per progress event, and one
always-last `{"type":"result","subtype":"success|error|max_turns",...}` line.
The outer `event`/`result` contract is documented and authoritative for the
run outcome, usage totals, `finalText`, and (when present) `sessionId`. Only
**unknown nested `AgentEvent` types** are treated as forward-compatible and
ignored; recognized nested events (`tool_queued`, `tool_running`,
`tool_completed`, `tool_errored`, `text_delta`, `run_start`, …) are surfaced.

The adapter:

- Treats the final `result` line as the only execution-outcome authority.
  `subtype: "error"` fails the run even when the OS exit code is `0`;
  `subtype: "max_turns"` (and exit code `8`) is represented as a distinct
  max-turns outcome with the partial `finalText` preserved. A process that exits
  `0` with no `result` line fails closed.
- Maps documented usage keys (`inputTokens`, `outputTokens`, `cacheReadTokens`,
  `cacheWriteTokens`) to Paperclip usage; `cacheReadTokens` → cached input
  tokens. Results carry no cost, so cost is reported as unknown rather than
  fabricated.
- Normalizes stdout, stderr, exit code, timeout, token usage, and the session
  id consistently across runs. Free-form assistant text is never execution
  authority.

## Sessions

When a prior run left a session id for the same working directory, the adapter
resumes it with `--resume <id>`. The ambiguous process-global `--continue` flag
is deliberately not used. If a resumed session is reported as unknown or stale,
the adapter retries once with a fresh run and **preserves any new session id**
returned by the retry, clearing the stored session only when the retry produced
no new session.

## Model discovery

The server discovers models at runtime via `cmd --list-models` (cached briefly),
so the model dropdown reflects what your Command Code install actually offers.
