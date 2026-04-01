'use strict';

const crypto = require('crypto');

const { writeEvent } = require('./whitebox-events');

const APPROVED_EXECUTORS = new Set(['claude', 'codex', 'gemini']);

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'run';
}

function createRunId(kind, hint) {
  const prefix = slugify(kind || 'run');
  const suffix = hint ? `-${slugify(hint)}` : '';
  const randomPart = crypto.randomBytes(3).toString('hex');
  return `${prefix}${suffix}-${Date.now()}-${randomPart}`;
}

function hashText(value) {
  return crypto.createHash('sha256').update(String(value || ''), 'utf8').digest('hex');
}

function normalizeExecutorName(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) return null;
  if (raw === 'codex' || raw.startsWith('codex ')) return 'codex';
  if (raw === 'gemini' || raw.startsWith('gemini ')) return 'gemini';
  if (raw === 'claude' || raw.startsWith('claude ') || raw.startsWith('sonnet') || raw.startsWith('opus') || raw.startsWith('haiku')) {
    return 'claude';
  }
  return raw;
}

function toEventWriteFailure(stage, type, error) {
  return {
    stage,
    event_type: type,
    message: error && error.message ? error.message : String(error),
    code: error && error.code ? error.code : null,
  };
}

async function emitRunEventDetailed({
  type,
  producer,
  data,
  projectDir,
  correlationId,
  causationId,
  stage,
  mode = 'best_effort',
}) {
  try {
    const event = await writeEvent({
      type,
      producer,
      correlation_id: correlationId || undefined,
      causation_id: causationId || undefined,
      data,
    }, {
      projectDir,
    });

    return {
      ok: true,
      event,
      error: null,
      failure: null,
    };
  } catch (error) {
    const failure = toEventWriteFailure(stage || type, type, error);
    if (mode === 'strict') {
      const strictError = new Error(`Failed to write ${type}: ${failure.message}`);
      strictError.code = 'WHITEBOX_EVENT_WRITE_FAILED';
      strictError.cause = error;
      strictError.failure = failure;
      throw strictError;
    }

    return {
      ok: false,
      event: null,
      error,
      failure,
    };
  }
}

async function emitRunEvent({ type, producer, data, projectDir, correlationId, causationId, stage }) {
  const result = await emitRunEventDetailed({
    type,
    producer,
    data,
    projectDir,
    correlationId,
    causationId,
    stage,
    mode: 'best_effort',
  });
  return result.ok ? result.event : null;
}

async function emitRunEventStrict({ type, producer, data, projectDir, correlationId, causationId, stage }) {
  const result = await emitRunEventDetailed({
    type,
    producer,
    data,
    projectDir,
    correlationId,
    causationId,
    stage,
    mode: 'strict',
  });
  return result.event;
}

function withExecutorMetadata(executor, extra = {}) {
  const normalized = normalizeExecutorName(executor);
  return {
    executor: normalized,
    approved_executor: normalized ? APPROVED_EXECUTORS.has(normalized) : false,
    ...extra,
  };
}

module.exports = {
  APPROVED_EXECUTORS,
  createRunId,
  emitRunEvent,
  emitRunEventDetailed,
  emitRunEventStrict,
  hashText,
  normalizeExecutorName,
  toEventWriteFailure,
  withExecutorMetadata,
};
