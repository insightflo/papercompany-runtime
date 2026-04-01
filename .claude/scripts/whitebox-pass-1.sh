#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
EVIDENCE_DIR="$ROOT_DIR/.tmp/whitebox-evidence"

mkdir -p "$EVIDENCE_DIR"

(cd "$ROOT_DIR/project-team" && npm test) 2>&1 | tee "$EVIDENCE_DIR/pass-1-tests.txt"

FIXTURE_DIR="$(mktemp -d "$ROOT_DIR/.tmp/pass1-fixture.XXXXXX")"
mkdir -p "$FIXTURE_DIR/.claude/collab/requests"
node -e "const fs=require('fs'); const path=require('path'); const dir=process.argv[1]; fs.mkdirSync(path.join(dir,'.claude','collab'), {recursive:true}); fs.writeFileSync(path.join(dir,'TASKS.md'), '## Phase 1\n### [ ] T0.1: Pass 1 fixture\n', 'utf8'); fs.writeFileSync(path.join(dir,'.claude','orchestrate-state.json'), JSON.stringify({tasks:[{id:'T0.1',title:'Pass 1 fixture',status:'pending',owner:'fixture-agent'}]}, null, 2), 'utf8'); fs.writeFileSync(path.join(dir,'.claude','collab','events.ndjson'), '', 'utf8');" "$FIXTURE_DIR"

# gate-chain.js removed with orchestrate-standalone; domain-analyzer validates team formation instead
(cd "$FIXTURE_DIR" && node "$ROOT_DIR/skills/team-orchestrate/scripts/domain-analyzer.js" --tasks-file "$FIXTURE_DIR/TASKS.md" --json) 2>&1 | tee "$EVIDENCE_DIR/pass-1-domain-analysis.txt"
