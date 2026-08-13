# OpenClaw Gateway Adapter

This document describes how `@paperclipai/adapter-openclaw-gateway` invokes OpenClaw over the Gateway protocol.

## Transport

This adapter always uses WebSocket gateway transport.

- URL must be `ws://` or `wss://`
- Connect flow follows gateway protocol:
1. receive `connect.challenge`
2. send `req connect` (protocol/client/auth/device payload)
3. negotiate v3-v4 by default (`minProtocol=3`, `maxProtocol=4`)
4. send `req agent`
5. wait for completion via `req agent.wait`
6. stream v3 `event agent` and v4 `event chat` frames into Paperclip logs/transcript parsing
- Set `protocolVersion=3` or `protocolVersion=4` to pin a gateway. The default range retries once with v3 only after a structured protocol-range rejection; auth and transport failures are not retried as protocol fallbacks.

## Auth Modes

Gateway credentials can be provided in any of these ways:

- `authToken` / `token` in adapter config
- `headers.x-openclaw-token`
- `headers.x-openclaw-auth` (legacy)
- `password` (shared password mode)
- `deviceToken` / `bootstrapToken` (device/bootstrap auth modes)

When a token is present and `authorization` header is missing, the adapter derives `Authorization: Bearer <token>`.

## Device Auth

By default the adapter sends a signed `device` payload in `connect` params.

- set `disableDeviceAuth=true` to omit device signing
- set `devicePrivateKeyPem` to pin a stable signing key
- without `devicePrivateKeyPem`, the adapter generates an ephemeral Ed25519 keypair per run
- when `autoPairOnFirstConnect` is enabled (default), the adapter handles one initial `pairing required` by calling `device.pair.list` + `device.pair.approve` over shared auth, then retries once.

## Session Strategy

The adapter supports the same session routing model as HTTP OpenClaw mode:

- `sessionKeyStrategy=issue|fixed|run`
- `sessionKey` is used when strategy is `fixed`

Resolved session key is sent as `agent.sessionKey`. When `agentId` is configured, issue and run strategies include it (`agent:<agentId>:paperclip:issue:<issueId>` / `agent:<agentId>:paperclip:run:<runId>`) to prevent cross-agent session reuse; fixed keys are routed the same way unless already prefixed with `agent:`. Without a gateway `agentId`, the legacy key shape is preserved.

## Payload Mapping

The agent request is built as:

- required fields:
  - `message` (wake text plus optional `payloadTemplate.message`/`payloadTemplate.text` prefix)
  - `idempotencyKey` (Paperclip `runId`)
  - `sessionKey` (resolved strategy)
- structured wake context JSON carries the standardized Papercompany run, issue, workspace, and workspaceRuntime mapping
- the v4 agent request omits root-level `paperclip` because upstream AgentParams validation rejects unknown fields
- optional additions:
  - fields supported by the closed v4 `AgentParams` schema are merged at the request root
  - `payloadTemplate.agentId` overrides `agentId` for both outbound routing and session-key scoping; otherwise the configured `agentId` is used
  - legacy `text`/`paperclip` and unsupported template fields are preserved in the structured wake-message context, not sent as unknown roots
  - v4 `chat` deltas use `deltaText`, replacement snapshots use `replace=true`, and the server-side result summary deduplicates cumulative message snapshots

The claimed API-key JSON path defaults to `~/.openclaw/workspace/paperclip-claimed-api-key.json` and can be overridden with `claimedApiKeyPath`.

## Timeouts

- `timeoutSec` controls adapter-level request budget
- `waitTimeoutMs` controls `agent.wait.timeoutMs`

If `agent.wait` returns `timeout`, adapter returns `openclaw_gateway_wait_timeout`.

## Log Format

Structured gateway event logs use:

- `[openclaw-gateway] ...` for lifecycle/system logs
- `[openclaw-gateway:event] run=<id> stream=<stream> data=<json>` for `event agent` and v4 `event chat` frames

UI/CLI parsers consume these lines to render transcript updates. The server-side result summary deduplicates cumulative snapshots, but the shared board transcript type currently has no replacement marker; therefore the raw UI transcript may still show a cumulative final snapshot after earlier deltas. Fixing that display behavior requires a shared UI/type change and is intentionally outside this package-local change.
