#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SCHEMA_VERSION = '1.0';

function metaFilePath(projectDir) {
  return path.join(projectDir, '.claude', 'collab', 'derived-meta.json');
}

function ensureParentDir(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

function readMarkers(projectDir) {
  const file = metaFilePath(projectDir);
  if (!fs.existsSync(file)) return [];

  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeMarkers(projectDir, markers) {
  const file = metaFilePath(projectDir);
  ensureParentDir(file);
  fs.writeFileSync(file, JSON.stringify(markers, null, 2), 'utf8');
}

function setStaleMarker(options = {}) {
  const projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const artifact = options.artifact;
  const schemaVersion = options.schemaVersion || SCHEMA_VERSION;
  const reason = options.reason || 'unknown';
  if (!artifact) throw new Error('artifact is required');

  const markers = readMarkers(projectDir);
  const now = new Date().toISOString();

  const next = markers.filter((entry) => entry.artifact !== artifact || entry.cleared_by);
  next.push({
    artifact,
    schema_version: schemaVersion,
    stale_since: now,
    reason,
    cleared_by: null,
  });
  writeMarkers(projectDir, next);
  return next;
}

function clearStaleMarker(options = {}) {
  const projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const artifact = options.artifact;
  const clearedBy = options.clearedBy || 'unknown';
  if (!artifact) throw new Error('artifact is required');

  const markers = readMarkers(projectDir);
  const next = markers.map((entry) => {
    if (entry.artifact === artifact && !entry.cleared_by) {
      return {
        artifact: entry.artifact,
        schema_version: entry.schema_version || SCHEMA_VERSION,
        stale_since: entry.stale_since || new Date().toISOString(),
        reason: entry.reason || 'unknown',
        cleared_by: clearedBy,
      };
    }
    return entry;
  });
  writeMarkers(projectDir, next);
  return next;
}

function parseArgs(argv) {
  const opts = { action: '', artifact: '', reason: '', clearedBy: '', projectDir: process.cwd() };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if ((arg === 'set' || arg === 'clear') && !opts.action) {
      opts.action = arg;
    } else if (arg === '--artifact' && argv[i + 1]) {
      opts.artifact = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--artifact=')) {
      opts.artifact = arg.slice('--artifact='.length);
    } else if (arg === '--reason' && argv[i + 1]) {
      opts.reason = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--reason=')) {
      opts.reason = arg.slice('--reason='.length);
    } else if (arg === '--cleared-by' && argv[i + 1]) {
      opts.clearedBy = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--cleared-by=')) {
      opts.clearedBy = arg.slice('--cleared-by='.length);
    } else if (arg === '--project-dir' && argv[i + 1]) {
      opts.projectDir = path.resolve(argv[i + 1]);
      i += 1;
    } else if (arg.startsWith('--project-dir=')) {
      opts.projectDir = path.resolve(arg.slice('--project-dir='.length));
    }
  }
  return opts;
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.action || !opts.artifact) {
    process.stderr.write('Usage: node collab-derived-meta.js <set|clear> --artifact <name> [--reason <text>] [--cleared-by <id>] [--project-dir <dir>]\n');
    process.exit(1);
  }

  let markers;
  if (opts.action === 'set') {
    markers = setStaleMarker({
      projectDir: opts.projectDir,
      artifact: opts.artifact,
      reason: opts.reason || 'manual_set',
    });
  } else {
    markers = clearStaleMarker({
      projectDir: opts.projectDir,
      artifact: opts.artifact,
      clearedBy: opts.clearedBy || 'manual_clear',
    });
  }

  process.stdout.write(JSON.stringify({
    mode: 'array',
    markers,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  setStaleMarker,
  clearStaleMarker,
  readMarkers,
  writeMarkers,
  metaFilePath,
};
