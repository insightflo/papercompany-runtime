export const type = "openclaw_gateway";
export const label = "OpenClaw Gateway";

export const models: { id: string; label: string }[] = [];

export const agentConfigurationDoc = `# openclaw_gateway agent configuration

Adapter: openclaw_gateway

Use when:
- You want Paperclip to invoke OpenClaw over the Gateway WebSocket protocol.
- You want native gateway auth/connect semantics instead of HTTP /v1/responses or /hooks/*.

Don't use when:
- You only expose OpenClaw HTTP endpoints.
- Your deployment does not permit outbound WebSocket access from the Paperclip server.

Core fields:
- url (string, required): OpenClaw gateway WebSocket URL (ws:// or wss://)
- headers (object, optional): handshake headers; supports x-openclaw-token / x-openclaw-auth
- authToken (string, optional): shared gateway token override
- deviceToken / bootstrapToken (string, optional): gateway device/bootstrap token used for connect and device signing when authToken is absent
- password (string, optional): gateway shared password, if configured

Gateway protocol compatibility fields:
- protocolVersion (3 | 4, optional): pin one gateway protocol version when negotiation is unavailable
- minProtocol / maxProtocol (3 | 4, optional): negotiated protocol range; defaults to 3..4
- fallbackProtocolVersion (3 | 4, optional): one explicit fallback after a structured protocol-range rejection; defaults to v3 for the 3..4 range

Gateway connect identity fields:
- clientId (string, optional): gateway client id (default gateway-client)
- clientMode (string, optional): gateway client mode (default backend)
- clientVersion (string, optional): client version string
- role (string, optional): gateway role (default operator)
- scopes (string[] | comma string, optional): gateway scopes (default ["operator.admin"])
- disableDeviceAuth (boolean, optional): disable signed device payload in connect params (default false)

Request behavior fields:
- payloadTemplate (object, optional): fields matching OpenClaw v4 AgentParams are sent at the request root; legacy text and paperclip fields plus unsupported fields are preserved in the structured wake message instead of being sent as unknown roots. payloadTemplate.agentId overrides config.agentId for routing and session scope
- workspaceRuntime (object, optional): desired runtime service intents; Paperclip preserves these in the structured wake context for remote execution environments
- timeoutSec (number, optional): adapter timeout in seconds (default 120)
- waitTimeoutMs (number, optional): agent.wait timeout override (default timeoutSec * 1000)
- autoPairOnFirstConnect (boolean, optional): on first "pairing required", attempt device.pair.list/device.pair.approve via shared auth, then retry once (default true)
- paperclipApiUrl (string, optional): absolute Paperclip base URL advertised in wake text
- claimedApiKeyPath (string, optional): agent-readable claimed API-key JSON path (default ~/.openclaw/workspace/paperclip-claimed-api-key.json)

Session routing fields:
- sessionKeyStrategy (string, optional): issue (default), fixed, or run
- sessionKey (string, optional): fixed session key when strategy=fixed; when gateway agentId is configured, all resolved keys are agent-scoped unless already prefixed with agent:

Standard Papercompany context mapping:
- Paperclip preserves the standardized workspace/workspaces/workspaceRuntime context in the structured wake message JSON.
- The v4 gateway agent request does not send a root-level \`paperclip\` field because upstream AgentParams validation rejects unknown root fields.

Standard result metadata supported:
- meta.runtimeServices (array, optional): normalized adapter-managed runtime service reports
- meta.previewUrl (string, optional): shorthand single preview URL
- meta.previewUrls (string[], optional): shorthand multiple preview URLs
`;
