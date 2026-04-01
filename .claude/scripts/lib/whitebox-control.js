'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { setStaleMarker } = require('../collab-derived-meta');
const { withLock } = require('./collab-lock');
const { readNdjsonFile } = require('./ndjson');
const { readEvents, writeEvent } = require('./whitebox-events');

const CONTROL_SCHEMA_VERSION = '1.0';
const CONTROL_LOG_REL_PATH = '.claude/collab/control.ndjson';
const CONTROL_STATE_ARTIFACT = '.claude/collab/control-state.json';
const CONTROL_AUDIT_EVENT = 'whitebox.control.command.recorded';
const ALLOWED_CONTROL_TYPES = new Set(['approve', 'reject']);
const REQUIRED_COMMAND_KEYS = ['command_id', 'ts', 'type', 'producer', 'target', 'actor', 'correlation_id', 'idempotency_key'];

function resolveProjectDir(projectDir) {
  return path.resolve(projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd());
}

function resolveControlFilePath(options = {}) {
  return path.join(resolveProjectDir(options.projectDir), CONTROL_LOG_REL_PATH);
}

function createCommandId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `cmd_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function normalizeString(value) {
  if (value === undefined || value === null) return null;
  const normalized = String(value).trim();
  return normalized || null;
}

function normalizeActor(actor) {
  if (actor && typeof actor === 'object' && !Array.isArray(actor)) {
    const next = { ...actor };
    if (next.id !== undefined && next.id !== null) {
      next.id = String(next.id).trim();
    }
    return next;
  }

  return {
    id: normalizeString(actor) || process.env.WHITEBOX_ACTOR || process.env.USER || 'unknown',
    role: normalizeString(process.env.CLAUDE_AGENT_ROLE),
  };
}

function buildDefaultIdempotencyKey(command) {
  return [
    'whitebox-control',
    command.type,
    command.correlation_id || 'no-correlation',
    command.target.gate_id,
  ].join(':');
}

function buildCommand(input = {}) {
  const target = input.target && typeof input.target === 'object' && !Array.isArray(input.target)
    ? { ...input.target }
    : {};

  const type = normalizeString(input.type);
  const correlationId = normalizeString(input.correlation_id || input.correlationId);
  const causationId = normalizeString(input.causation_id || input.causationId);
  const producer = normalizeString(input.producer) || 'whitebox-control';
  const reason = normalizeString(input.reason);
  const command = {
    command_id: normalizeString(input.command_id || input.commandId) || createCommandId(),
    ts: normalizeString(input.ts) || new Date().toISOString(),
    type,
    producer,
    target,
    actor: normalizeActor(input.actor),
    reason,
    correlation_id: correlationId,
    causation_id: causationId,
    idempotency_key: normalizeString(input.idempotency_key || input.idempotencyKey),
  };

  if (!command.idempotency_key) {
    command.idempotency_key = buildDefaultIdempotencyKey(command);
  }

  return command;
}

function validateCommand(command) {
  const errors = [];
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, errors: ['command must be an object'] };
  }
  if (!normalizeString(command.command_id)) errors.push('command_id is required');
  if (!normalizeString(command.ts)) errors.push('ts is required');
  if (!normalizeString(command.type)) {
    errors.push('type is required');
  } else if (!ALLOWED_CONTROL_TYPES.has(command.type)) {
    errors.push(`type must be one of: ${Array.from(ALLOWED_CONTROL_TYPES).join(', ')}`);
  }
  if (!normalizeString(command.producer)) errors.push('producer is required');
  if (!command.target || typeof command.target !== 'object' || Array.isArray(command.target)) {
    errors.push('target must be an object');
  } else if (!normalizeString(command.target.gate_id)) {
    errors.push('target.gate_id is required');
  }
  if (!command.actor || typeof command.actor !== 'object' || Array.isArray(command.actor)) {
    errors.push('actor must be an object');
  } else if (!normalizeString(command.actor.id)) {
    errors.push('actor.id is required');
  }
  if (!normalizeString(command.correlation_id)) errors.push('correlation_id is required');
  if (!normalizeString(command.idempotency_key)) errors.push('idempotency_key is required');
  return { ok: errors.length === 0, errors };
}

function readControlCommands(options = {}) {
  const filePath = resolveControlFilePath(options);
  if (!fs.existsSync(filePath)) {
    return { file: filePath, commands: [], errors: [] };
  }

  const parsed = readNdjsonFile(filePath);
  return {
    file: filePath,
    commands: parsed.records,
    errors: parsed.errors,
  };
}

function validateCommandRecord(command) {
  const errors = [];
  if (!command || typeof command !== 'object' || Array.isArray(command)) {
    return { ok: false, errors: ['command must be an object'] };
  }

  for (const key of REQUIRED_COMMAND_KEYS) {
    if (!(key in command)) errors.push(`missing required key: ${key}`);
  }

  const validation = validateCommand(command);
  errors.push(...validation.errors);
  return { ok: errors.length === 0, errors };
}

function validateControlCommands(options = {}) {
  const parsed = readControlCommands(options);
  let valid = 0;
  let schemaInvalid = 0;

  for (const command of parsed.commands) {
    const validation = validateCommandRecord(command);
    if (validation.ok) {
      valid += 1;
    } else {
      schemaInvalid += 1;
    }
  }

  return {
    ok: parsed.errors.length === 0 && schemaInvalid === 0,
    total: parsed.commands.length + parsed.errors.length,
    valid,
    invalid: parsed.errors.length + schemaInvalid,
    parse_errors: parsed.errors,
  };
}

function createWriteError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function shouldForceControlWriteFailure() {
  const raw = String(process.env.WHITEBOX_FORCE_CONTROL_WRITE_FAILURE || '').trim();
  return raw === '1' || raw === 'true';
}

async function emitControlAudit(command, projectDir) {
  try {
    return await writeEvent({
      type: CONTROL_AUDIT_EVENT,
      producer: command.producer,
      correlation_id: command.correlation_id,
      causation_id: command.command_id,
      data: {
        command_id: command.command_id,
        control_type: command.type,
        target: command.target,
        actor: command.actor,
        idempotency_key: command.idempotency_key,
      },
    }, {
      projectDir,
    });
  } catch (error) {
    throw createWriteError(
      'WHITEBOX_CONTROL_AUDIT_FAILED',
      `Failed to write ${CONTROL_AUDIT_EVENT}: ${error.message}`,
      { failure: error }
    );
  }
}

function hasControlAudit(projectDir, command) {
  const parsed = readEvents({ projectDir, tolerateTrailingPartialLine: true });
  return parsed.events.some((event) => event
    && event.type === CONTROL_AUDIT_EVENT
    && event.causation_id === command.command_id);
}

async function ensureControlAudit(command, projectDir) {
  if (hasControlAudit(projectDir, command)) {
    return { emitted: false, status: 'already_recorded' };
  }

  await emitControlAudit(command, projectDir);
  return { emitted: true, status: 'recorded' };
}

async function writeControlCommand(input = {}, options = {}) {
  const projectDir = resolveProjectDir(options.projectDir);
  const filePath = resolveControlFilePath({ projectDir });
  const command = buildCommand(input);
  const validation = validateCommand(command);
  if (!validation.ok) {
    throw createWriteError('WHITEBOX_CONTROL_INVALID', `invalid control command: ${validation.errors.join('; ')}`, {
      validation,
      command,
    });
  }

  let result = null;
  try {
    if (shouldForceControlWriteFailure()) {
      throw new Error('forced control write failure');
    }
    await withLock('control-ndjson', async () => {
      const existing = readControlCommands({ projectDir }).commands;
      const duplicate = existing.find((entry) => entry && entry.idempotency_key === command.idempotency_key);
      if (duplicate) {
        result = {
          ok: true,
          status: 'already_applied',
          command: duplicate,
          duplicate_of: duplicate.command_id || null,
        };
        return;
      }

      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.appendFileSync(filePath, `${JSON.stringify(command)}\n`, 'utf8');
      result = {
        ok: true,
        status: 'recorded',
        command,
        duplicate_of: null,
      };
    }, {
      projectDir,
      file: filePath,
      lockedBy: command.actor.id,
    });
  } catch (error) {
    throw createWriteError('WHITEBOX_CONTROL_WRITE_FAILED', `Failed to write control command: ${error.message}`, {
      failure: error,
      command,
    });
  }

  await ensureControlAudit(result.command, projectDir);

  try {
    setStaleMarker({
      projectDir,
      artifact: CONTROL_STATE_ARTIFACT,
      reason: `control command ${result.command.type}; rebuild required`,
    });
  } catch {
  }

  return result;
}

module.exports = {
  ALLOWED_CONTROL_TYPES,
  CONTROL_AUDIT_EVENT,
  CONTROL_LOG_REL_PATH,
  CONTROL_SCHEMA_VERSION,
  CONTROL_STATE_ARTIFACT,
  buildCommand,
  buildDefaultIdempotencyKey,
  readControlCommands,
  resolveControlFilePath,
  validateControlCommands,
  validateCommand,
  writeControlCommand,
};
