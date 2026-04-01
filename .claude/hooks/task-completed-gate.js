#!/usr/bin/env node
/**
 * TaskCompleted Hook — Agent Teams Quality Gate
 *
 * [파일 목적] 작업 완료 시 경량 품질 게이트를 수행
 * [주요 흐름]
 *   1. stdin에서 TaskCompleted 이벤트 JSON 읽기
 *   2. 완료된 작업이 TASKS.md에 존재하는지 확인
 *   3. 경량 품질 체크 (contract compliance, basic lint)
 *   4. 결정 (allow/deny/warn) + whitebox 이벤트 로깅
 * [외부 연결] hook-decision-event.js → whitebox-events.js
 * [수정시 주의] quality-gate.js의 전체 게이트와 구분 — 여기는 경량 체크만
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { emitHookDecision } = require('./lib/hook-decision-event');

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const QUALITY_CHECKS = {
  // 완료된 작업이 TASKS.md에 존재해야 함
  validateTaskExists: true,
  // 변경된 파일이 작업 scope 내에 있어야 함
  validateFileScope: true,
  // 기본 lint 체크 (에러만 차단, 경고는 허용)
  blockOnLintErrors: false,
};

// ---------------------------------------------------------------------------
// Validation Checks
// ---------------------------------------------------------------------------

/**
 * [목적] 작업 ID가 TASKS.md에 존재하는지 확인
 * [입력] taskId — 작업 식별자, projectDir — 프로젝트 루트
 * [출력] { exists: boolean, status: string }
 */
function validateTaskExists(taskId, projectDir) {
  const tasksPath = path.join(projectDir, 'TASKS.md');
  if (!fs.existsSync(tasksPath)) {
    return { exists: false, status: 'no_tasks_file' };
  }

  try {
    const content = fs.readFileSync(tasksPath, 'utf8');
    const escapedId = taskId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escapedId}\\b`);

    if (!pattern.test(content)) {
      return { exists: false, status: 'not_found' };
    }

    // 작업 완료 여부 확인
    const completedPattern = new RegExp(
      `\\[x\\]\\s+${escapedId}:`,
      'i'
    );
    const isCompleted = completedPattern.test(content);

    return {
      exists: true,
      status: isCompleted ? 'completed' : 'pending',
    };
  } catch {
    return { exists: false, status: 'read_error' };
  }
}

/**
 * [목적] 변경된 파일이 작업의 files scope 내에 있는지 확인
 * [입력] taskId — 작업 식별자, changedFiles — 변경 파일 목록, projectDir — 프로젝트 루트
 * [출력] { inScope: boolean, outOfScope: string[] }
 * [주의] files 메타데이터가 없는 작업은 모든 파일을 허용 (scope 미지정 = 무제한)
 */
function validateFileScope(taskId, changedFiles, projectDir) {
  if (!changedFiles || changedFiles.length === 0) {
    return { inScope: true, outOfScope: [] };
  }

  const tasksPath = path.join(projectDir, 'TASKS.md');
  if (!fs.existsSync(tasksPath)) {
    // scope 체크 불가 — 허용
    return { inScope: true, outOfScope: [] };
  }

  try {
    const content = fs.readFileSync(tasksPath, 'utf8');

    // 작업의 files 메타데이터 추출
    const taskStart = content.indexOf(taskId);
    if (taskStart === -1) {
      return { inScope: true, outOfScope: [] };
    }

    const taskSection = content.slice(taskStart, taskStart + 500);
    const filesMatch = taskSection.match(/files:\s*(.+)/i);

    if (!filesMatch) {
      // files 미지정 — 모든 파일 허용
      return { inScope: true, outOfScope: [] };
    }

    const allowedPatterns = filesMatch[1]
      .split(',')
      .map((p) => p.trim())
      .filter(Boolean);

    // 패턴 매칭으로 scope 확인
    const outOfScope = changedFiles.filter((file) => {
      return !allowedPatterns.some((pattern) => {
        if (pattern.includes('*')) {
          const regex = new RegExp('^' + pattern.replace(/\*/g, '.*') + '$');
          return regex.test(file);
        }
        return file.startsWith(pattern);
      });
    });

    return {
      inScope: outOfScope.length === 0,
      outOfScope,
    };
  } catch {
    return { inScope: true, outOfScope: [] };
  }
}

/**
 * [Purpose] Auto-sync TASKS.md when a task is completed.
 * Finds the task by ID or subject and marks it [x].
 * [Input] taskId — task identifier or subject, projectDir — project root
 * [Output] { synced: boolean, file: string|null }
 */
function syncTasksMd(taskId, taskSubject, projectDir) {
  const tasksPath = path.join(projectDir, 'TASKS.md');
  if (!fs.existsSync(tasksPath)) {
    return { synced: false, file: null };
  }

  try {
    let content = fs.readFileSync(tasksPath, 'utf8');
    let synced = false;

    // Try matching by task ID (e.g., P0-T0.1, T1.2)
    const candidates = [taskId, taskSubject].filter(Boolean);

    for (const candidate of candidates) {
      if (!candidate || candidate === 'unknown') continue;

      // Extract task ID pattern from candidate (e.g., "P0-T0.1" from "P0-T0.1: Setup monorepo")
      const idMatch = candidate.match(/^([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*(?:\.\d+)*)/);
      if (!idMatch) continue;

      const id = idMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

      // Match "- [ ] P0-T0.1:" or "### [ ] P0-T0.1:" patterns
      const pattern = new RegExp(`(- \\[)[ /](\\]\\s+${id}:)`, 'g');
      const newContent = content.replace(pattern, '$1x$2');

      if (newContent !== content) {
        content = newContent;
        synced = true;
      }
    }

    if (synced) {
      fs.writeFileSync(tasksPath, content, 'utf8');
      return { synced: true, file: 'TASKS.md' };
    }

    return { synced: false, file: null };
  } catch {
    return { synced: false, file: null };
  }
}

/**
 * [Purpose] Lightweight quality check on task completion.
 * [Input] taskId, teammate, projectDir
 * [Output] { passed: boolean, issues: string[] }
 */
function runLightweightQualityCheck(taskId, _teammate, projectDir) {
  const issues = [];

  // 작업 존재 확인
  if (QUALITY_CHECKS.validateTaskExists) {
    const taskCheck = validateTaskExists(taskId, projectDir);
    if (!taskCheck.exists) {
      issues.push(`Task ${taskId} not found in TASKS.md (status: ${taskCheck.status})`);
    }
  }

  return {
    passed: issues.length === 0,
    issues,
  };
}

// ---------------------------------------------------------------------------
// Main Entry Point
// ---------------------------------------------------------------------------

async function main() {
  let rawInput = '';

  // stdin에서 hook 이벤트 데이터 읽기
  try {
    rawInput = fs.readFileSync('/dev/stdin', 'utf8').trim();
  } catch {
    rawInput = '{}';
  }

  let input;
  try {
    input = JSON.parse(rawInput || '{}');
  } catch {
    input = {};
  }

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const taskId = input.tool_input?.task_id || input.task_id || input.task_subject || 'unknown';
  const taskSubject = input.tool_input?.task_subject || input.task_subject || '';
  const teammate = input.tool_input?.teammate || input.teammate_name || input.teammate || 'unknown';
  const changedFiles = input.tool_input?.changed_files || input.changed_files || [];

  // Auto-sync TASKS.md — mark completed task as [x]
  const syncResult = syncTasksMd(taskId, taskSubject, projectDir);

  // Lightweight quality check
  const qualityResult = runLightweightQualityCheck(taskId, teammate, projectDir);

  // 파일 scope 체크
  let scopeResult = { inScope: true, outOfScope: [] };
  if (QUALITY_CHECKS.validateFileScope) {
    scopeResult = validateFileScope(taskId, changedFiles, projectDir);
    if (!scopeResult.inScope) {
      qualityResult.issues.push(
        `Files out of scope: ${scopeResult.outOfScope.join(', ')}`
      );
      qualityResult.passed = false;
    }
  }

  // 결정 로직
  let decision;
  let reason = '';

  if (!qualityResult.passed) {
    decision = 'warn';
    reason = qualityResult.issues.join('; ');
  } else {
    decision = 'approve';
    reason = '';
  }

  // whitebox 이벤트 로깅
  await emitHookDecision(input, {
    hook: 'task-completed-gate',
    decision,
    severity: decision === 'warn' ? 'warning' : 'info',
    summary: decision === 'approve'
      ? `Task ${taskId} completed by ${teammate} — quality checks passed`
      : `Task ${taskId} completed by ${teammate} with issues: ${reason}`,
    remediation: decision === 'warn'
      ? 'Review the issues and ensure task scope compliance.'
      : '',
  });

  // stdout에 결정 JSON 출력
  process.stdout.write(JSON.stringify({
    decision,
    reason,
    taskId,
    teammate,
    tasksMdSynced: syncResult.synced,
    checks: {
      quality: qualityResult,
      fileScope: scopeResult,
    },
  }));
}

if (require.main === module) {
  main().catch((err) => { console.error('[task-completed-gate] Unhandled error:', err.message); });
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUALITY_CHECKS,
    validateTaskExists,
    validateFileScope,
    runLightweightQualityCheck,
  };
}
