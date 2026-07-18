# Gazua market-pulse n8n workflow

This directory generates `Gazua - Market Pulse 30m Collect and A1 Sync`. It collects the fast-changing Gazua market cards every 30 minutes from Monday 09:00 through Saturday 06:00 Korea time. The workflow timezone and execution guard are both `Asia/Seoul`; Saturday 06:00 is included and Saturday 06:30 through Monday 08:30 is excluded.

The 30-minute source set includes Yahoo Finance market symbols, alternative.me Fear and Greed, and the exact `DDR5 16Gb (2Gx8) 4800/5600` DRAMeXchange row. Weekly freight indexes are intentionally left to their existing collector.

## UI-managed credentials

Create or select these credentials in n8n. Do not put their values in source, exported workflow JSON, shell history, or request bodies.

- `papercompany-minio-n8n`: existing S3 credential for MinIO.
- `papercompany-gazua-webhook`: existing HTTP Header Auth credential for the manual webhook.
- `gazua-a1-market-pulse-ingest`: HTTP Header Auth credential for the A1 ingest endpoint. Its header name is `Authorization`; its protected value is managed only in n8n and A1.

Pass credential IDs and the protected n8n API-key file path at runtime:

```sh
export N8N_MINIO_CREDENTIAL_ID='<minio-credential-id>'
export N8N_GAZUA_WEBHOOK_CREDENTIAL_ID='<webhook-credential-id>'
export N8N_GAZUA_A1_CREDENTIAL_ID='<a1-header-auth-credential-id>'
export N8N_API_KEY_FILE='<protected-n8n-api-key-file>'
```

`N8N_API_KEY_FILE` defaults to `~/.config/papercompany/n8n-api-key`. No credential ID has a source-code default.

The public n8n URL defaults to `https://n8n-auto.showk.ing`. Override it only when needed:

```sh
export N8N_URL='https://n8n-auto.showk.ing'
```

For the established local SSH tunnel, connect to the override while retaining the public hostname for HTTP Host and TLS SNI:

```sh
export N8N_CONNECT_HOST='127.0.0.1'
export N8N_CONNECT_PORT='18443'
```

## Preview, apply, and activate

Preview is non-mutating and prints only the workflow name, node count, schedules, credential names, and public URLs:

```sh
node scripts/gazua-market-pulse/sync-workflow.mjs --preview
```

Apply creates or updates the exact-name workflow. A newly created workflow remains inactive. The helper aborts before mutation if duplicate exact-name workflows exist.

```sh
node scripts/gazua-market-pulse/sync-workflow.mjs --apply
```

Activation applies first and then calls the n8n activation endpoint. Use it only after the manual success and controlled partial-failure acceptance checks pass.

```sh
node scripts/gazua-market-pulse/sync-workflow.mjs --activate
```

## Manual acceptance

The authenticated webhook path is `papercompany/gazua-market-pulse-30m`, with `responseMode: lastNode`. A manual request must have this JSON body:

```json
{"manual":true}
```

A controlled non-critical source failure can be requested without changing the saved workflow:

```json
{"manual":true,"testFailKey":"Uranium_ETF"}
```

The only accepted `testFailKey` values are `Copper`, `NaturalGas`, and `Uranium_ETF`. Confirm the failed source status uses that request key, its previous value is carried forward when available, other cards update, and the run writes a synchronization receipt. Confirm the public result at `https://gazua.showk.ing/api/market-pulse`.

## MinIO objects

All objects use bucket `data` and these keys:

```text
gazua/market-pulse/latest.json
gazua/market-pulse/history/YYYY/MM/DD/HHmm.json
gazua/market-pulse/history/YYYY/MM/DD/HHmm-retry-<first-12-hash-chars>.json
gazua/market-pulse/sync-receipts/YYYY/MM/DD/HHmm-<n8n-execution-id>.json
gazua/market-pulse/ddr5-changes/YYYY/MM/DD/HHmm-<first-12-hash-chars>.json
```

History is written before `latest.json`. An identical same-slot hash skips a duplicate history upload; conflicting same-slot content uses the deterministic retry key. DDR5 change objects are emitted only when its value or source update text changes. The A1 receipt is persisted before a failed synchronization is asserted.

## Rollback

Deactivate `Gazua - Market Pulse 30m Collect and A1 Sync` in n8n. Deactivation stops new scheduled runs but retains MinIO history, latest state, receipts, DDR5 events, and A1's last valid local snapshots. Do not delete those objects during rollback.

## Local verification

```sh
node --check scripts/gazua-market-pulse/workflow-definition.mjs
node --check scripts/gazua-market-pulse/sync-workflow.mjs
node --test scripts/gazua-market-pulse/workflow-definition.test.mjs
```
