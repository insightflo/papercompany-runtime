'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const DEFAULT_TTL_SECONDS = 600;
const DEFAULT_MAX_WAIT_MS = 5000;
const DEFAULT_RETRY_DELAY_MS = 100;

function sleepMs(ms) {
  if (ms <= 0) return;
  const sab = new SharedArrayBuffer(4);
  const int32 = new Int32Array(sab);
  Atomics.wait(int32, 0, 0, ms);
}

function safeParseJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function sanitizeLockName(lockName) {
  return String(lockName || 'default').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function getLockFilePath(lockName, projectDir) {
  const name = sanitizeLockName(lockName);
  return path.join(projectDir, '.claude', 'collab', 'locks', `${name}.json`);
}

function isLockExpired(lockData, nowMs) {
  if (!lockData || !lockData.timestamp) return true;
  const ts = new Date(lockData.timestamp).getTime();
  if (Number.isNaN(ts)) return true;
  const ttl = Number(lockData.ttl_seconds);
  const ttlSeconds = Number.isFinite(ttl) && ttl > 0 ? ttl : DEFAULT_TTL_SECONDS;
  return nowMs > ts + (ttlSeconds * 1000);
}

function tryRemoveStaleLock(lockPath, nowMs) {
  let lockData = null;
  try {
    lockData = safeParseJson(fs.readFileSync(lockPath, 'utf8'));
  } catch {
    return false;
  }

  if (!isLockExpired(lockData, nowMs)) return false;

  try {
    fs.unlinkSync(lockPath);
    return true;
  } catch {
    return false;
  }
}

function acquireLock(lockName, options = {}) {
  const projectDir = options.projectDir || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const ttlSeconds = Number.isFinite(Number(options.ttlSeconds)) ? Number(options.ttlSeconds) : DEFAULT_TTL_SECONDS;
  const maxWaitMs = Number.isFinite(Number(options.maxWaitMs)) ? Number(options.maxWaitMs) : DEFAULT_MAX_WAIT_MS;
  const retryDelayMs = Number.isFinite(Number(options.retryDelayMs)) ? Number(options.retryDelayMs) : DEFAULT_RETRY_DELAY_MS;

  const lockPath = getLockFilePath(lockName, projectDir);
  const locksDir = path.dirname(lockPath);
  fs.mkdirSync(locksDir, { recursive: true });

  const deadline = Date.now() + Math.max(0, maxWaitMs);
  const lockPayload = {
    file: options.file || lockName,
    locked_by: options.lockedBy || process.env.CLAUDE_AGENT_ROLE || `${os.hostname()}:${process.pid}`,
    timestamp: new Date().toISOString(),
    ttl_seconds: ttlSeconds,
  };

  while (Date.now() <= deadline) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      try {
        fs.writeFileSync(fd, JSON.stringify(lockPayload, null, 2), 'utf8');
      } finally {
        fs.closeSync(fd);
      }
      return { lockPath, acquired: true };
    } catch (err) {
      if (!err || err.code !== 'EEXIST') {
        throw err;
      }

      const nowMs = Date.now();
      const removed = tryRemoveStaleLock(lockPath, nowMs);
      if (!removed) {
        sleepMs(Math.max(1, retryDelayMs));
      }
    }
  }

  const timeoutErr = new Error(`timed out acquiring lock: ${lockName}`);
  timeoutErr.code = 'LOCK_TIMEOUT';
  throw timeoutErr;
}

function releaseLock(lockPath) {
  try {
    fs.unlinkSync(lockPath);
  } catch {
  }
}

async function withLock(lockName, fn, options = {}) {
  const { lockPath } = acquireLock(lockName, options);
  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}

module.exports = {
  withLock,
  getLockFilePath,
  acquireLock,
  releaseLock,
};
