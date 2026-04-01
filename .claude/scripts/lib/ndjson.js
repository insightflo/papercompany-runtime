'use strict';

const fs = require('fs');
const path = require('path');

function previewContent(line) {
  return line.length > 160 ? line.slice(0, 160) : line;
}

function readNdjsonFile(filePath) {
  const records = [];
  const errors = [];

  let content;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (err) {
    errors.push({
      line: 0,
      error: err.message,
      content_preview: '',
    });
    return { records, errors };
  }

  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const raw = lines[i];
    if (raw === undefined) continue;
    const normalized = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!normalized.trim()) continue;

    try {
      records.push(JSON.parse(normalized));
    } catch (err) {
      errors.push({
        line: i + 1,
        error: err.message,
        content_preview: previewContent(normalized),
      });
    }
  }

  return { records, errors };
}

function parseArgs(argv) {
  const opts = { file: '' };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      opts.file = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      opts.file = arg.slice('--file='.length);
    }
  }
  return opts;
}

function runCli() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.file) {
    process.stderr.write('Usage: node ndjson.js --file <path>\n');
    process.exit(1);
  }

  const target = path.resolve(process.cwd(), opts.file);
  const result = readNdjsonFile(target);
  process.stdout.write(JSON.stringify({
    file: target,
    record_count: result.records.length,
    error_count: result.errors.length,
    records: result.records,
    errors: result.errors,
  }, null, 2));
}

if (require.main === module) {
  runCli();
}

module.exports = {
  readNdjsonFile,
};
