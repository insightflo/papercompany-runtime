#!/usr/bin/env node
/**
 * collab-init.js
 *
 * Initializes the .claude/collab/ collaboration directory structure
 * for the hierarchical agent communication protocol.
 *
 * Usage:
 *   node collab-init.js [--project-dir=/path/to/project]
 *   node collab-init.js --check   # check if already initialized
 *
 * Directories created:
 *   .claude/collab/
 *   ├── contracts/        architecture-lead-only write (Wave 0 outputs)
 *   ├── requests/         REQ-*.md files (cross-domain change requests)
 *   ├── decisions/        DEC-*.md files (architecture-lead rulings)
 *   ├── locks/            JSON lock files (TTL: 10 min)
 *   ├── archive/          Wave-end archival of completed REQ/DEC files
 *   ├── control.ndjson    Canonical operator-intent log (append-only)
 *   ├── control-state.json Derived control state (rebuildable, never edit directly)
 *   ├── board-state.json  Current kanban board snapshot (derived, never edit directly)
 *   └── events.ndjson     Append-only board event log
 */

const fs = require('fs');
const path = require('path');

// Status messages go to stderr; stdout is reserved for JSON output
function log(msg) {
  process.stderr.write(msg + '\n');
}

const COLLAB_README = `# Agent Collaboration Bus

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
  Phase 1 action types are limited to \`approve\` and \`reject\`.

- **control-state.json**: Derived whitebox control query state.
  Disposable/read-only projection for CLI read verbs and TUI rendering.
  Never edit directly; rebuild from canonical command/event logs.

- **board-state.json**: Current kanban board snapshot (Backlog / In Progress / Blocked / Done).
  Derived from TASKS.md + orchestrate-state.json + requests/. Never edit directly.

- **events.ndjson**: Append-only board event log.
  One JSON event per line: task_claimed, task_started, task_done, task_blocked,
  req_escalated, req_resolved.

## Whitebox Surface Contract

- \`/whitebox\` is the only product boundary.
- The TUI is the interactive renderer/operator shell for \`/whitebox\`.
- The CLI mutation surface is the shared mutation path and headless/scriptable surface.
- The whitebox surface handles all board rendering and state visualization.

## REQ File Format

\`\`\`yaml
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
\`\`\`

See: project-team/references/communication-protocol.md
`;

const SUBDIRS = ['contracts', 'requests', 'decisions', 'locks', 'archive'];
const REQUIRED_FILES = ['board-state.json', 'events.ndjson', 'control.ndjson', 'control-state.json'];

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { projectDir: process.cwd(), check: false };

  for (const arg of args) {
    if (arg === '--check') {
      options.check = true;
    } else if (arg.startsWith('--project-dir=')) {
      options.projectDir = path.resolve(arg.slice('--project-dir='.length));
    }
  }

  return options;
}

function isInitialized(collabDir) {
  if (!fs.existsSync(collabDir)) return false;
  const hasDirs = SUBDIRS.every((d) => fs.existsSync(path.join(collabDir, d)));
  const hasFiles = REQUIRED_FILES.every((f) => fs.existsSync(path.join(collabDir, f)));
  return hasDirs && hasFiles;
}

function init(projectDir) {
  const collabDir = path.join(projectDir, '.claude', 'collab');

  if (isInitialized(collabDir)) {
    log(`collab already initialized: ${collabDir}`);
    return { skipped: true, path: collabDir };
  }

  // Create each subdirectory
  for (const sub of SUBDIRS) {
    const subDir = path.join(collabDir, sub);
    fs.mkdirSync(subDir, { recursive: true });
    // .gitkeep to preserve empty dirs in git
    const gitkeep = path.join(subDir, '.gitkeep');
    if (!fs.existsSync(gitkeep)) {
      fs.writeFileSync(gitkeep, '');
    }
  }

  // Write README
  const readmePath = path.join(collabDir, 'README.md');
  fs.writeFileSync(readmePath, COLLAB_README);

  // Initialize events.ndjson (empty)
  const eventsPath = path.join(collabDir, 'events.ndjson');
  if (!fs.existsSync(eventsPath)) {
    fs.writeFileSync(eventsPath, '');
  }

  const controlLogPath = path.join(collabDir, 'control.ndjson');
  if (!fs.existsSync(controlLogPath)) {
    fs.writeFileSync(controlLogPath, '');
  }

  const controlStatePath = path.join(collabDir, 'control-state.json');
  if (!fs.existsSync(controlStatePath)) {
    fs.writeFileSync(
      controlStatePath,
      JSON.stringify(
        {
          schema_version: 1,
          derived: true,
          artifact: 'control-state',
          source: ['.claude/collab/events.ndjson', '.claude/collab/control.ndjson'],
          pending_approvals: [],
          updated_at: null,
        },
        null,
        2
      ) + '\n'
    );
  }

  log(`collab initialized: ${collabDir}`);
  for (const sub of SUBDIRS) {
    log(`  ${sub}/`);
  }

  return { skipped: false, path: collabDir };
}

function main() {
  const { projectDir, check } = parseArgs();

  if (check) {
    const collabDir = path.join(projectDir, '.claude', 'collab');
    const initialized = isInitialized(collabDir);
    log(initialized ? 'initialized' : 'not initialized');
    process.exit(initialized ? 0 : 1);
  }

  init(projectDir);
  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = { init, isInitialized, SUBDIRS };
