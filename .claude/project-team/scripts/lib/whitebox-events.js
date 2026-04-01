'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { readNdjsonFile } = require('./ndjson');
const { redactObject } = require('./redact');

const DEFAULT_SCHEMA_VERSION = '1.0';
const DEFAULT_EVENTS_REL_PATH = '.claude/collab/events.ndjson';
const REQUIRED_KEYS = ['schema_version', 'event_id', 'ts', 'type', 'producer', 'data'];

function resolveProjectDir(projectDir) {
  return projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

function resolveEventsFilePath(opts = {}) {
  const projectDir = resolveProjectDir(opts.projectDir);
  const file = opts.file || DEFAULT_EVENTS_REL_PATH;
  return path.resolve(projectDir, file);
}

function createEventId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `evt_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function buildEnvelope(input) {
  const event = {
    schema_version: input.schema_version || DEFAULT_SCHEMA_VERSION,
    event_id: input.event_id || createEventId(),
    ts: input.ts || new Date().toISOString(),
    type: input.type,
    producer: input.producer,
    data: input.data,
  };

  if (input.correlation_id !== undefined && input.correlation_id !== null && input.correlation_id !== '') {
    event.correlation_id = String(input.correlation_id);
  }
  if (input.causation_id !== undefined && input.causation_id !== null && input.causation_id !== '') {
    event.causation_id = String(input.causation_id);
  }

  return event;
}

function validateEvent(event) {
  const errors = [];

  if (!event || typeof event !== 'object' || Array.isArray(event)) {
    return { ok: false, errors: ['event must be an object'] };
  }

  for (const key of REQUIRED_KEYS) {
    if (!(key in event)) errors.push(`missing required key: ${key}`);
  }

  if ('schema_version' in event && typeof event.schema_version !== 'string') errors.push('schema_version must be a string');
  if ('event_id' in event && typeof event.event_id !== 'string') errors.push('event_id must be a string');
  if ('ts' in event && typeof event.ts !== 'string') errors.push('ts must be a string');
  if ('type' in event && typeof event.type !== 'string') errors.push('type must be a string');
  if ('producer' in event && typeof event.producer !== 'string') errors.push('producer must be a string');
  if ('data' in event && (event.data === null || typeof event.data !== 'object' || Array.isArray(event.data))) {
    errors.push('data must be an object');
  }
  if ('correlation_id' in event && typeof event.correlation_id !== 'string') errors.push('correlation_id must be a string');
  if ('causation_id' in event && typeof event.causation_id !== 'string') errors.push('causation_id must be a string');

  return { ok: errors.length === 0, errors };
}

async function writeEvent(input, options = {}) {
  const event = redactObject(buildEnvelope(input || {}));
  const validation = validateEvent(event);
  if (!validation.ok) {
    const err = new Error(`invalid event: ${validation.errors.join('; ')}`);
    err.code = 'WHITEBOX_EVENT_INVALID';
    err.validation = validation;
    throw err;
  }

  const filePath = resolveEventsFilePath(options);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });

  fs.appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf8');

  return event;
}

function classifyTruncated(readResult, filePath, tolerateTrailingPartialLine) {
  if (!tolerateTrailingPartialLine || !readResult.errors.length) {
    return { truncatedLines: new Set(), totalLines: 0 };
  }

  let raw = '';
  try {
    raw = fs.readFileSync(filePath, 'utf8');
  } catch {
    return { truncatedLines: new Set(), totalLines: 0 };
  }

  const lines = raw.split('\n');
  const totalLines = lines.length;
  const hasTrailingNewline = raw.endsWith('\n');
  const lastNonEmptyLine = (() => {
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      if ((lines[i] || '').trim()) return i + 1;
    }
    return 0;
  })();

  const truncatedLines = new Set();
  for (const err of readResult.errors) {
    const msg = String(err.error || '');
    const trailingPartial = !hasTrailingNewline && err.line === lastNonEmptyLine;
    if (trailingPartial || (err.line === lastNonEmptyLine && msg.includes('Unexpected end of JSON input'))) {
      truncatedLines.add(err.line);
    }
  }
  return { truncatedLines, totalLines };
}

function readEvents(options = {}) {
  const filePath = resolveEventsFilePath({ file: options.file, projectDir: options.projectDir });
  const tolerateTrailingPartialLine = options.tolerateTrailingPartialLine !== false;

  const result = readNdjsonFile(filePath);
  const { truncatedLines } = classifyTruncated(result, filePath, tolerateTrailingPartialLine);

  const errors = result.errors.filter((e) => !truncatedLines.has(e.line)).map((e) => ({
    line: e.line,
    kind: 'invalid_json',
    message: e.error,
    content_preview: e.content_preview,
  }));

  const truncated = result.errors.filter((e) => truncatedLines.has(e.line)).map((e) => ({
    line: e.line,
    kind: 'truncated',
    message: e.error,
    content_preview: e.content_preview,
  }));

  return {
    file: filePath,
    events: result.records,
    errors,
    truncated,
  };
}

function validateEvents(options = {}) {
  const parsed = readEvents({
    file: options.file,
    projectDir: options.projectDir,
    tolerateTrailingPartialLine: true,
  });

  let valid = 0;
  let schemaInvalid = 0;
  const schemaVersions = new Set();

  for (const event of parsed.events) {
    const validation = validateEvent(event);
    if (validation.ok) {
      valid += 1;
      if (typeof event.schema_version === 'string') schemaVersions.add(event.schema_version);
    } else {
      schemaInvalid += 1;
    }
  }

  const invalid = parsed.errors.length + schemaInvalid;
  const truncated = parsed.truncated.length;
  const total = parsed.events.length + parsed.errors.length + parsed.truncated.length;

  return {
    ok: invalid === 0 && truncated === 0,
    total,
    valid,
    invalid,
    truncated,
    schemaVersions: Array.from(schemaVersions).sort(),
  };
}

module.exports = {
  writeEvent,
  readEvents,
  validateEvents,
};
