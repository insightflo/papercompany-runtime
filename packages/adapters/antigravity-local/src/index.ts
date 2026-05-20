export const type = "antigravity_local";
export const label = "Antigravity (local)";

export const models: Array<{ id: string; label: string }> = [
  { id: "auto", label: "Auto (Antigravity settings)" },
];

export const DEFAULT_ANTIGRAVITY_LOCAL_MODEL = "auto";

export const agentConfigurationDoc = `# antigravity_local agent configuration

Adapter: antigravity_local

Use when:
- You want Paperclip to run Google's Antigravity CLI (agy) locally as the agent runtime
- You want one-shot headless print-mode runs with Antigravity's local auth/session state

Don't use when:
- agy is not installed or not authenticated on the host
- You need structured JSONL/token events; agy stdout is treated as plain text for now

Core fields:
- cwd (string, optional): default absolute working directory fallback for the agent process (created if missing when possible)
- instructionsFilePath (string, optional): markdown instructions file path resolved from the effective cwd and prepended to the run prompt
- promptTemplate (string, optional): run prompt template
- command (string, optional): defaults to "agy"
- printTimeout (string, optional): passed to --print-timeout, defaults to "180s"
- bypassPermissions / dangerouslySkipPermissions (boolean, optional): passes --dangerously-skip-permissions
- sandbox (boolean, optional): passes --sandbox when true
- model (string, optional): stored/reported for compatibility; defaults to "auto" because current agy has no model flag
- effort (string, optional): stored for compatibility with common local-agent Thinking effort UI; current agy has no effort flag
- chrome (boolean, optional): stored for compatibility with common local-agent Enable Chrome UI; current agy has no chrome flag
- extraArgs (string[], optional): additional CLI flags inserted before --print
- env (object, optional): KEY=VALUE environment variables

Operational notes:
- Flags are placed before --print because agy treats args after --print as prompt text.
- Paperclip always passes --add-dir <cwd> so file/tool actions use the intended workspace.
- Sessions are restored with --conversation when a saved conversation id matches the current cwd.
- Model selection is controlled by Antigravity settings; Paperclip exposes "auto" only until a stable agy model flag exists.
`;
