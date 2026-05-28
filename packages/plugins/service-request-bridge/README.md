# Service Request Bridge Plugin

Cross-company service request bridge for Paperclip.

## Features

- BridgeLink entity model for local issue <-> remote issue mapping
- Automatic status synchronization on `issue.updated`
- Loop-safe sync via sync-stamp and event idempotency keys
- Issue list tab UI: linked/unlinked badges + remote company info
- Issue detail tab UI: linked remote issue status + bridge creation form

## Build

```bash
cd plugins/service-request-bridge
pnpm install
pnpm build
```

## Install (example)

```bash
paperclipai plugin install --api-base http://localhost:3100 ./plugins/service-request-bridge
```
