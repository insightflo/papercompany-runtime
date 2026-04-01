#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EVIDENCE_DIR="$ROOT_DIR/.tmp/whitebox-evidence"

mkdir -p "$EVIDENCE_DIR"

FIXTURE_DIR="$(mktemp -d "$ROOT_DIR/.tmp/pass2-fixture.XXXXXX")"
mkdir -p "$FIXTURE_DIR/bin" "$FIXTURE_DIR/.claude/collab/requests"
mkdir -p "$FIXTURE_DIR/.claude/collab/contracts" "$FIXTURE_DIR/.claude/collab/decisions" "$FIXTURE_DIR/.claude/collab/locks" "$FIXTURE_DIR/.claude/collab/archive"

node -e "const fs=require('fs'); const path=require('path'); const dir=process.argv[1]; fs.mkdirSync(path.join(dir,'.claude','collab'), {recursive:true}); fs.writeFileSync(path.join(dir,'TASKS.md'), '## Phase 2\n### [ ] T0.1: Pass 2 fixture\n', 'utf8'); fs.writeFileSync(path.join(dir,'.claude','orchestrate-state.json'), JSON.stringify({tasks:[{id:'T0.1',title:'Pass 2 fixture',status:'pending',owner:'fixture-agent'}]}, null, 2), 'utf8'); fs.writeFileSync(path.join(dir,'.claude','collab','events.ndjson'), '', 'utf8');" "$FIXTURE_DIR"

cat > "$FIXTURE_DIR/bin/claude" <<'EOF'
#!/bin/sh
exit 0
EOF
cat > "$FIXTURE_DIR/bin/codex" <<'EOF'
#!/bin/sh
[ "$1" = "auth" ] && [ "$2" = "status" ] && exit 0
exit 0
EOF
cat > "$FIXTURE_DIR/bin/gemini" <<'EOF'
#!/bin/sh
[ "$1" = "auth" ] && [ "$2" = "status" ] && exit 0
exit 0
EOF
chmod +x "$FIXTURE_DIR/bin/claude" "$FIXTURE_DIR/bin/codex" "$FIXTURE_DIR/bin/gemini"

node "$ROOT_DIR/project-team/scripts/collab-init.js" --project-dir="$FIXTURE_DIR" 2>&1 | tee "$EVIDENCE_DIR/pass-2-collab.txt"
node "$ROOT_DIR/project-team/scripts/collab-init.js" --check --project-dir="$FIXTURE_DIR" 2>&1 | tee -a "$EVIDENCE_DIR/pass-2-collab.txt"
node "$ROOT_DIR/skills/whitebox/scripts/whitebox-control-state.js" --project-dir="$FIXTURE_DIR" > /dev/null
node "$ROOT_DIR/project-team/scripts/events-validate.js" --file "$FIXTURE_DIR/.claude/collab/events.ndjson" 2>&1 | tee "$EVIDENCE_DIR/pass-2-events.txt"
CLAUDECODE=attached PATH="$FIXTURE_DIR/bin:/usr/bin:/bin:${PATH}" node "$ROOT_DIR/skills/whitebox/scripts/whitebox-health.js" --project-dir="$FIXTURE_DIR" --json 2>&1 | tee "$EVIDENCE_DIR/pass-2-health.json"
