# Agent Collaboration Bus

File-based communication bus for the hierarchical agent collaboration system.

## Directories

- **contracts/**: architecture-lead-only write, all agents read-only.
  Created during Wave 0 before Domain Workers begin.
  Contains: api-schema.yaml, types.ts, error-codes.md

- **requests/**: REQ-*.md files for cross-domain change requests.
  Any agent can create REQ files here.
  Status flow: OPEN → PENDING → RESOLVED/REJECTED/ESCALATED

- **decisions/**: DEC-*.md files issued by architecture-lead.
  Created when a REQ is ESCALATED (max_negotiation exceeded).
  Final rulings that all agents must follow.

- **locks/**: JSON lock files to prevent concurrent writes.
  Format: { file, locked_by, timestamp, ttl_seconds }
  Default TTL: 600 seconds (10 minutes).
  Stale locks (expired TTL) can be safely removed.

- **archive/**: Wave-end archival of completed REQ/DEC files.
  Moved here after wave completion to reduce context overhead.

- **control.ndjson**: Canonical operator-intent log for whitebox approval commands.
  Append-only. Written only by the Node whitebox CLI mutation surface.
  Phase 1 action types are limited to `approve` and `reject`.

- **control-state.json**: Derived whitebox control query state.
  Disposable/read-only projection for CLI read verbs and TUI rendering.
  Never edit directly; rebuild from canonical command/event logs.

- **board-state.json**: Current kanban board snapshot (Backlog / In Progress / Blocked / Done).
  Derived from TASKS.md + orchestrate-state.json + requests/. Never edit directly.

- **events.ndjson**: Append-only board event log.
  One JSON event per line: task_claimed, task_started, task_done, task_blocked,
  req_escalated, req_resolved.

## Whitebox Surface Contract

- `/whitebox` is the only product boundary.
- The TUI is the interactive renderer/operator shell for `/whitebox`.
- The CLI mutation surface is the shared mutation path and headless/scriptable surface.
- The whitebox surface handles all board rendering and state visualization.

## REQ File Format

```yaml
---
id: REQ-YYYYMMDD-NNN
thread_id: thread-{domain}-{topic}
from: architecture-lead
to: design-lead
task_ref: T2.3
status: OPEN
max_negotiation: 2
negotiation_count: 0
timestamp: ISO8601
---
## Change Summary (<=500 chars)
[description]

## Response
[receiver fills this in]
```

See: project-team/references/communication-protocol.md
