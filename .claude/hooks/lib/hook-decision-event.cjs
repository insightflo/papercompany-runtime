'use strict';

const path = require('path');

/**
 * Resolve whitebox-events module from multiple candidate paths.
 * Supports both source repo layout and installed project layout.
 */
function resolveWhiteboxEvents() {
  const candidates = [
    // Source repo: project-team/hooks/lib/ → project-team/scripts/lib/
    path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'whitebox-events'),
    // Installed project: .claude/hooks/lib/ → .claude/project-team/scripts/lib/
    path.resolve(__dirname, '..', '..', 'project-team', 'scripts', 'lib', 'whitebox-events'),
    // Installed project: .claude/hooks/lib/ → .claude/scripts/lib/
    path.resolve(__dirname, '..', '..', 'scripts', 'lib', 'whitebox-events'),
  ];

  for (const candidate of candidates) {
    try { return require(candidate); } catch {}
  }

  // Fallback: no-op writeEvent (hooks should not crash the session)
  return { writeEvent: async () => ({}) };
}

const { writeEvent } = resolveWhiteboxEvents();

function sanitizeSummary(summary) {
  if (typeof summary !== 'string') return '';
  return summary.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function resolveCorrelationId(input = {}, fallback = {}) {
  const toolInput = input.tool_input || {};
  return toolInput.task_id
    || fallback.filePath
    || input.hook_event_name
    || 'unknown';
}

function defaultSeverity(decision) {
  if (decision === 'block') return 'error';
  if (decision === 'warn') return 'warning';
  return 'info';
}

async function emitHookDecision(input = {}, payload = {}) {
  const hook = payload.hook || 'unknown-hook';
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || '';
  const correlationId = resolveCorrelationId(input, { filePath });

  const data = {
    hook,
    decision: payload.decision || 'skip',
    severity: payload.severity || defaultSeverity(payload.decision || 'skip'),
  };

  if (input.hook_event_name) data.hook_event_name = input.hook_event_name;
  if (input.tool_name) data.tool_name = input.tool_name;
  if (payload.risk_level) data.risk_level = payload.risk_level;

  const summary = sanitizeSummary(payload.summary);
  if (summary) data.summary = summary;

  const remediation = sanitizeSummary(payload.remediation);
  if (remediation) data.remediation = remediation;

  try {
    await writeEvent({
      type: 'hook.decision',
      producer: hook,
      correlation_id: correlationId,
      data,
    }, {
      projectDir: process.env.CLAUDE_PROJECT_DIR || process.cwd(),
    });
  } catch {
  }
}

module.exports = {
  emitHookDecision,
};
