#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

function parseArgs(argv) {
  const opts = { file: '', out: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      opts.file = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length);
    } else if (arg === '--out' && argv[i + 1]) {
      opts.out = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--out=')) {
      opts.out = arg.slice('--out='.length);
    }
  }
  return opts;
}

function repairNdjson(filePath, outPath) {
  const input = fs.readFileSync(filePath, 'utf8');
  const lines = input.split('\n');
  const keptLines = [];

  let dropped = 0;
  let total = 0;

  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const normalized = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!normalized.trim()) continue;
    total += 1;

    try {
      JSON.parse(normalized);
      keptLines.push(raw);
    } catch {
      dropped += 1;
    }
  }

  const output = keptLines.length > 0 ? `${keptLines.join('\n')}\n` : '';
  fs.writeFileSync(outPath, output, 'utf8');
  return {
    file: filePath,
    out: outPath,
    total_lines: total,
    kept_lines: keptLines.length,
    dropped_lines: dropped,
  };
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file || !opts.out) {
    process.stderr.write('Usage: node collab-repair.js --file <path> --out <path>\n');
    process.exit(1);
  }

  const filePath = path.resolve(process.cwd(), opts.file);
  const outPath = path.resolve(process.cwd(), opts.out);
  const outDir = path.dirname(outPath);
  fs.mkdirSync(outDir, { recursive: true });

  const result = repairNdjson(filePath, outPath);
  process.stdout.write(JSON.stringify(result, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = {
  repairNdjson,
};
