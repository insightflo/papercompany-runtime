#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { file: '', maxBytes: 0, archiveDir: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      opts.file = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length);
    } else if (arg === '--max-bytes' && argv[i + 1]) {
      opts.maxBytes = parseInt(argv[i + 1], 10);
      i += 1;
    } else if (arg.startsWith('--max-bytes=')) {
      opts.maxBytes = parseInt(arg.slice('--max-bytes='.length), 10);
    } else if (arg === '--archive-dir' && argv[i + 1]) {
      opts.archiveDir = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--archive-dir=')) {
      opts.archiveDir = arg.slice('--archive-dir='.length);
    }
  }
  return opts;
}

function buildTimestampSuffix() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}T${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}Z`;
}

function rotateIfNeeded(filePath, maxBytes, archiveDir) {
  const parentDir = path.dirname(filePath);
  fs.mkdirSync(parentDir, { recursive: true });

  if (!fs.existsSync(filePath)) {
    fs.writeFileSync(filePath, '', 'utf8');
    return { rotated: false, archived_to: null, bytes: 0 };
  }

  const stat = fs.statSync(filePath);
  if (stat.size <= maxBytes) {
    return { rotated: false, archived_to: null, bytes: stat.size };
  }

  fs.mkdirSync(archiveDir, { recursive: true });
  const base = path.basename(filePath);
  const archived = path.join(archiveDir, `${base}.${buildTimestampSuffix()}`);
  fs.renameSync(filePath, archived);
  fs.writeFileSync(filePath, '', 'utf8');

  return { rotated: true, archived_to: archived, bytes: stat.size };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file || !opts.archiveDir || !Number.isFinite(opts.maxBytes) || opts.maxBytes < 0) {
    process.stderr.write('Usage: node collab-rotate.js --file <path> --max-bytes <N> --archive-dir <dir>\n');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), opts.file);
  const archiveDir = path.resolve(process.cwd(), opts.archiveDir);
  const result = rotateIfNeeded(filePath, opts.maxBytes, archiveDir);

  process.stdout.write(JSON.stringify({
    file: filePath,
    max_bytes: opts.maxBytes,
    archive_dir: archiveDir,
    rotated: result.rotated,
    archived_to: result.archived_to,
    bytes_before: result.bytes,
  }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  rotateIfNeeded,
};
