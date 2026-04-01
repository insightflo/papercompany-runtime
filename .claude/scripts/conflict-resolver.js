#!/usr/bin/env node
/**
 * conflict-resolver.js
 *
 * Wave Barrier gate: scans .claude/collab/requests/ for unresolved REQ files
 * and escalates stalled negotiations to architecture-lead.
 *
 * Called by orchestrate.sh at each Wave Barrier gate.
 *
 * Exit codes:
 *   0 — all REQs resolved (or no REQs), safe to proceed to next wave
 *   1 — error reading collab directory
 *   2 — ESCALATED REQs found (architecture-lead must mediate before continuing)
 *
 * Usage:
 *   node conflict-resolver.js [--project-dir=/path] [--auto-escalate] [--json]
 *
 * Options:
 *   --project-dir=PATH   project root (default: cwd)
 *   --auto-escalate      automatically escalate OPEN REQs past their TTL
 *   --json               output JSON report to stdout
 *   --ttl=MINUTES        minutes before OPEN REQ is auto-escalated (default: 30)
 */

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function parseArgs() {
  const args = process.argv.slice(2);
  const opts = {
    projectDir: process.cwd(),
    autoEscalate: false,
    json: false,
    ttlMinutes: 30,
  };

  for (const arg of args) {
    if (arg.startsWith('--project-dir=')) {
      opts.projectDir = path.resolve(arg.slice('--project-dir='.length));
    } else if (arg === '--auto-escalate') {
      opts.autoEscalate = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('--ttl=')) {
      const parsed = parseInt(arg.slice('--ttl='.length), 10);
      opts.ttlMinutes = !isNaN(parsed) ? parsed : 30;
    }
  }

  return opts;
}

// ---------------------------------------------------------------------------
// REQ file parsing
// ---------------------------------------------------------------------------

/**
 * Parse YAML frontmatter from a REQ/DEC markdown file.
 * Returns an object with the frontmatter fields and the body text.
 */
function parseFrontmatter(content) {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };

  const meta = {};
  for (const line of match[1].split('\n')) {
    const colonIdx = line.indexOf(':');
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    let value = line.slice(colonIdx + 1).trim();
    // Strip quotes
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    // Parse arrays like [A, B]
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map((s) => s.trim()).filter(Boolean);
    }
    // Parse integers
    if (/^\d+$/.test(value)) value = parseInt(value, 10);
    meta[key] = value;
  }

  return { meta, body: match[2] };
}

function readREQFiles(requestsDir) {
  if (!fs.existsSync(requestsDir)) return [];

  const files = fs.readdirSync(requestsDir).filter((f) => f.match(/^REQ-.*\.md$/));
  const reqs = [];

  for (const file of files) {
    const filePath = path.join(requestsDir, file);
    try {
      const content = fs.readFileSync(filePath, 'utf8');
      const { meta, body } = parseFrontmatter(content);
      reqs.push({ file, filePath, meta, body, raw: content });
    } catch {
      // Skip unreadable files
    }
  }

  return reqs;
}

// ---------------------------------------------------------------------------
// Escalation logic
// ---------------------------------------------------------------------------

function isStale(meta, ttlMinutes) {
  if (!meta.timestamp) return false;
  const created = new Date(meta.timestamp);
  if (isNaN(created.getTime())) return false;
  const ageMinutes = (Date.now() - created.getTime()) / 60000;
  return ageMinutes > ttlMinutes;
}

function escalateREQ(req, reason) {
  const content = req.raw;
  const updated = content.replace(
    /^status:\s*.+$/m,
    'status: ESCALATED'
  );
  fs.writeFileSync(req.filePath, updated, 'utf8');
  return { ...req.meta, status: 'ESCALATED', escalation_reason: reason };
}

// ---------------------------------------------------------------------------
// Report generation
// ---------------------------------------------------------------------------

function buildReport(opts, reqs) {
  const report = {
    resolved: [],
    pending: [],  // PENDING status (acknowledged, under analysis)
    escalated: [],
    open: [],     // OPEN status (not yet acknowledged)
  };

  for (const req of reqs) {
    const { meta } = req;
    const status = (meta.status || '').toUpperCase();

    if (status === 'RESOLVED' || status === 'REJECTED') {
      report.resolved.push(meta.id || req.file);
      continue;
    }

    if (status === 'ESCALATED') {
      report.escalated.push(meta.id || req.file);
      continue;
    }

    if (status === 'PENDING') {
      // PENDING: acknowledged by receiver but negotiation ongoing
      const count = Number(meta.negotiation_count) || 0;
      const max = Number(meta.max_negotiation) || 2;

      if (count >= max) {
        if (opts.autoEscalate) {
          escalateREQ(req, `negotiation_count (${count}) >= max_negotiation (${max})`);
          report.escalated.push(meta.id || req.file);
        } else {
          report.pending.push(meta.id || req.file);
        }
        continue;
      }

      if (opts.autoEscalate && isStale(meta, opts.ttlMinutes)) {
        escalateREQ(req, `REQ has been PENDING for more than ${opts.ttlMinutes} minutes`);
        report.escalated.push(meta.id || req.file);
        continue;
      }

      report.pending.push(meta.id || req.file);
      continue;
    }

    if (!['OPEN', 'PENDING', 'RESOLVED', 'REJECTED', 'ESCALATED'].includes(status)) {
      // Unknown/malformed status — treat as OPEN
      report.open.push(meta.id || req.file);
      continue;
    }

    if (status === 'OPEN') {
      // Check negotiation count vs max
      const count = Number(meta.negotiation_count) || 0;
      const max = Number(meta.max_negotiation) || 2;

      if (count >= max) {
        if (opts.autoEscalate) {
          escalateREQ(req, `negotiation_count (${count}) >= max_negotiation (${max})`);
          report.escalated.push(meta.id || req.file);
        } else {
          // Not auto-escalating: keep open so architecture-lead can decide manually
          report.open.push(meta.id || req.file);
        }
        continue;
      }

      // Check TTL staleness
      if (opts.autoEscalate && isStale(meta, opts.ttlMinutes)) {
        escalateREQ(req, `REQ has been OPEN for more than ${opts.ttlMinutes} minutes`);
        report.escalated.push(meta.id || req.file);
        continue;
      }

      report.open.push(meta.id || req.file);
    }
  }

  return report;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

function main() {
  const opts = parseArgs();
  const requestsDir = path.join(opts.projectDir, '.claude', 'collab', 'requests');

  // stderr for human-readable messages; stdout reserved for --json output
  const log = (msg) => process.stderr.write(msg + '\n');

  let reqs;
  try {
    reqs = readREQFiles(requestsDir);
  } catch (err) {
    const errMsg = `conflict-resolver: failed to read requests/: ${err.message}`;
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: errMsg }));
    } else {
      log(errMsg);
    }
    process.exit(1);
  }

  if (reqs.length === 0) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ resolved: [], pending: [], escalated: [], open: [] }));
    } else {
      log('[conflict-resolver] No REQ files found. Wave barrier passed.');
    }
    process.exit(0);
  }

  const report = buildReport(opts, reqs);

  if (opts.json) {
    process.stdout.write(JSON.stringify(report));
  } else {
    log('[conflict-resolver] Wave Barrier Report');
    log(`  Resolved/Rejected : ${report.resolved.length}`);
    log(`  Open/Pending      : ${report.open.length}`);
    log(`  Escalated         : ${report.escalated.length}`);

    if (report.escalated.length > 0) {
      log('\n[conflict-resolver] ESCALATED REQs require architecture-lead mediation:');
      for (const id of report.escalated) {
        log(`  - ${id}`);
      }
      log('\n[conflict-resolver] architecture-lead must create DEC files in .claude/collab/decisions/ before next wave.');
    }

    if (report.open.length > 0) {
      log('\n[conflict-resolver] Open REQs (still negotiating):');
      for (const id of report.open) {
        log(`  - ${id}`);
      }
    }
  }

  // Exit 2: ESCALATED REQs — architecture-lead must mediate before next wave
  if (report.escalated.length > 0) {
    process.exit(2);
  }

  // Exit 3: Active negotiations still in progress — wave should wait
  if (report.open.length > 0 || report.pending.length > 0) {
    process.exit(3);
  }

  process.exit(0);
}

if (require.main === module) {
  main();
}

module.exports = {
  parseFrontmatter,
  readREQFiles,
  buildReport,
  escalateREQ,
  isStale,
};
