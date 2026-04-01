#!/usr/bin/env node
'use strict';

const { validateEvents } = require('./lib/whitebox-events');

function parseArgs(argv) {
  let file = '';
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--file' && argv[i + 1]) {
      file = argv[i + 1];
      i += 1;
    } else if (arg.startsWith('--file=')) {
      file = arg.slice('--file='.length);
    }
  }
  return { file };
}

function printSummary(summary, file) {
  process.stdout.write(`file: ${file}\n`);
  process.stdout.write(`total records: ${summary.total}\n`);
  process.stdout.write(`valid count: ${summary.valid}\n`);
  process.stdout.write(`invalid count: ${summary.invalid}\n`);
  process.stdout.write(`truncated line count: ${summary.truncated}\n`);
  process.stdout.write(`schema versions seen: ${summary.schemaVersions.join(', ') || '(none)'}\n`);
}

function main() {
  const args = parseArgs(process.argv);
  if (!args.file) {
    process.stderr.write('Usage: node project-team/scripts/events-validate.js --file <path>\n');
    process.exit(2);
  }

  try {
    const summary = validateEvents({ file: args.file });
    printSummary(summary, args.file);
    process.exit(summary.ok ? 0 : 1);
  } catch (err) {
    process.stderr.write(`events-validate failed: ${err.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}
