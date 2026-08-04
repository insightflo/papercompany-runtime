export const type = "commandcode_local";
export const label = "Command Code (local)";

export const models: Array<{ id: string; label: string }> = [];

/**
 * Command Code exposes a wide model catalog via `cmd --list-models`, so
 * no static model list is shipped here. The server registry discovers models at
 * runtime through `discoverCommandCodeModels`. This default is only a fallback
 * suggestion for operators who have not selected a model yet.
 */
export const DEFAULT_COMMANDCODE_LOCAL_MODEL = "";

export const DEFAULT_COMMANDCODE_LOCAL_COMMAND = "cmd";

export const agentConfigurationDoc = `# commandcode_local agent configuration

Adapter: commandcode_local

Runs Command Code (\`cmd\`) locally as the agent runtime.

Use when:
- You want Paperclip to run the Command Code CLI headlessly on this machine
- You want one-shot non-interactive runs (\`cmd -p\`) with machine-readable NDJSON
- You need per-run model (\`--model\`) and reasoning effort (\`--effort\`) control

Don't use when:
- The \`cmd\` CLI is not installed or not authenticated on the host
- You need webhook-style external invocation (use openclaw_gateway or http)
- You only need one-shot shell commands (use process)

Core fields:
- command (string, optional): executable to invoke; defaults to "cmd"
- cwd (string, optional): default absolute working directory fallback (created if missing when possible)
- instructionsFilePath (string, optional): markdown instructions file resolved from the effective cwd and injected into the run prompt
- Papercompany-selected skills are synchronized into ".commandcode/skills" under the effective cwd, which Command Code discovers natively
- promptTemplate (string, optional): user prompt template sent via -p
- model (string, optional): passed to --model; an id from \`cmd --list-models\` (e.g. moonshotai/kimi-k2.5)
- effort (string, optional): reasoning effort passed to --effort; valid levels are model-specific (e.g. low, medium, high, xhigh, max). Omit to let the model use its own default.
- maxTurns (number, optional): passes --max-turns when > 0; unset by default
- env (object, optional): KEY=VALUE environment variables
- extraArgs (string[], optional): extra CLI flags inserted before -p (reserved output/automation/model/max-turns/resume/session flags are dropped to protect enforced behavior)
- dangerouslySkipPermissions (boolean, optional): when true, launch with --yolo and omit --permission-mode; when false/absent (safe default) use --permission-mode auto-accept

Operational fields:
- timeoutSec (number, optional): run timeout in seconds (0 = no hard timeout)
- graceSec (number, optional): SIGTERM grace period in seconds

Automation flags (always applied):
- -p <prompt>          non-interactive print mode
- --output-format json NDJSON event stream + final result line
- --skip-onboarding    skip taste onboarding for automated runs
- --permission-mode auto-accept  accept tool actions automatically (safe default; used unless dangerouslySkipPermissions is set)
- --yolo               passed instead of --permission-mode when dangerouslySkipPermissions is true; full skip of permission prompts
- --trust              auto-trust the project (skip permission prompt)
- --no-auto-update     avoid background self-updates during a managed run

Session behavior:
- Command Code supports -r/--resume <id>, -c/--continue, and --session <path|id>.
  This adapter targets an explicit session id with --resume <id> when one is
  available from a prior run and the working directory matches. It never uses the
  ambiguous --continue flag. If a resumed session is reported as unknown/stale,
  the adapter retries once with a fresh run and preserves any new session id
  returned by the retry, clearing the stored session only when no new session is
  returned.

Parsing:
- The outer NDJSON contract is documented: each progress line is
  {"type":"event","event":{...AgentEvent...}} and the always-last line is
  {"type":"result","subtype":"success|error|max_turns",...} carrying usage,
  durationMs, finalText, optional sessionId/stopReason, and optional error.
- The final result line is the ONLY execution-outcome authority. subtype "error"
  fails the run even at OS exit 0; subtype "max_turns" (or exit code 8) is a
  distinct max-turns outcome; a process that exits 0 with no result line fails
  closed. A result with stopReason "permission_denied" is treated as a failure
  (errorCode commandcode_permission_denied) even when the subtype is "success",
  because the run did not actually complete the requested work. Free-form
  assistant text is surfaced as a summary but is never execution authority.
- Only machine-produced JSON lines are interpreted. Unknown nested AgentEvent
  types are forward-compatible and ignored; recognized ones (tool_queued,
  tool_running, tool_completed, tool_errored, text_delta, run_start) are surfaced.
`;
