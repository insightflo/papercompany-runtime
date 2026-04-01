#!/usr/bin/env node
/**
 * TeammateIdle Hook — Agent Teams Governance Gate
 *
 * [파일 목적] 팀원이 유휴 상태가 될 때 거버넌스 체크를 수행
 * [주요 흐름]
 *   1. stdin에서 TeammateIdle 이벤트 JSON 읽기
 *   2. 팀원의 미완료 작업 확인
 *   3. 거버넌스 정책 체크 (policy-gate + risk-gate 재사용)
 *   4. 결정 (allow/warn) + whitebox 이벤트 로깅
 * [외부 연결] hook-decision-event.js → whitebox-events.js
 * [수정시 주의] stdout JSON 형식 변경 시 Claude Code 런타임과의 호환성 확인 필요
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { emitHookDecision } = require('./lib/hook-decision-event');

/**
 * RegExp 특수문자를 이스케이프하여 ReDoS 방지
 * @param {string} str
 * @returns {string}
 */
function escapeRegExp(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const GOVERNANCE_POLICIES = {
  // Teammate must not idle with unresolved ESCALATED requests
  checkEscalatedRequests: true,
  // Warn if teammate has pending tasks (not block)
  warnOnPendingTasks: true,
  // Maximum idle events before escalation
  maxIdleBeforeEscalation: 3,
};

// ---------------------------------------------------------------------------
// Governance Checks
// ---------------------------------------------------------------------------

/**
 * [목적] 팀원에게 배정된 미완료 작업이 있는지 확인
 * [입력] teammate — 팀원 식별자, projectDir — 프로젝트 루트
 * [출력] { hasPending: boolean, count: number, tasks: string[] }
 */
function checkPendingTasks(teammate, projectDir) {
  const tasksPath = path.join(projectDir, 'TASKS.md');
  if (!fs.existsSync(tasksPath)) {
    return { hasPending: false, count: 0, tasks: [] };
  }

  try {
    const content = fs.readFileSync(tasksPath, 'utf8');
    const pendingPattern = /^-\s*\[\s\]\s+([A-Z][A-Z0-9]*(?:-[A-Z0-9]+)*(?:\.\d+)*):\s*(.+)$/gm;
    const pending = [];
    let match;

    while ((match = pendingPattern.exec(content)) !== null) {
      pending.push({ id: match[1], description: match[2].trim() });
    }

    // Filter by owner if teammate info available (escape to prevent ReDoS)
    const ownerPattern = new RegExp(`owner:\\s*${escapeRegExp(teammate)}`, 'i');
    const teammateTasks = pending.filter((task) => {
      const taskSection = content.slice(
        content.indexOf(task.id),
        content.indexOf(task.id) + 500
      );
      return ownerPattern.test(taskSection);
    });

    return {
      hasPending: teammateTasks.length > 0,
      count: teammateTasks.length,
      tasks: teammateTasks.map((t) => t.id),
    };
  } catch {
    return { hasPending: false, count: 0, tasks: [] };
  }
}

/**
 * [목적] 미해결 ESCALATED 요청이 있는지 확인
 * [입력] teammate — 팀원 식별자, projectDir — 프로젝트 루트
 * [출력] { hasEscalated: boolean, count: number }
 */
function checkEscalatedRequests(teammate, projectDir) {
  const requestsDir = path.join(projectDir, '.claude', 'collab', 'requests');
  if (!fs.existsSync(requestsDir)) {
    return { hasEscalated: false, count: 0 };
  }

  try {
    const files = fs.readdirSync(requestsDir).filter((f) => f.startsWith('REQ-') && f.endsWith('.md'));
    let escalatedCount = 0;

    for (const file of files) {
      const content = fs.readFileSync(path.join(requestsDir, file), 'utf8');
      const isEscalated = /status:\s*ESCALATED/i.test(content);
      const escaped = escapeRegExp(teammate);
      const involvesTeammate =
        new RegExp(`from:\\s*${escaped}`, 'i').test(content) ||
        new RegExp(`to:\\s*${escaped}`, 'i').test(content);

      if (isEscalated && involvesTeammate) {
        escalatedCount++;
      }
    }

    return { hasEscalated: escalatedCount > 0, count: escalatedCount };
  } catch {
    return { hasEscalated: false, count: 0 };
  }
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
  const teammate = input.tool_input?.teammate || input.teammate || 'unknown';

  // 거버넌스 체크 실행
  const pendingResult = checkPendingTasks(teammate, projectDir);
  const escalatedResult = GOVERNANCE_POLICIES.checkEscalatedRequests
    ? checkEscalatedRequests(teammate, projectDir)
    : { hasEscalated: false, count: 0 };

  // 결정 로직
  let decision = 'approve';
  let reason = '';
  const warnings = [];

  // ESCALATED 요청이 있으면 경고
  if (escalatedResult.hasEscalated) {
    decision = 'warn';
    warnings.push(`${escalatedResult.count} unresolved ESCALATED request(s)`);
  }

  // 미완료 작업이 있으면 경고
  if (GOVERNANCE_POLICIES.warnOnPendingTasks && pendingResult.hasPending) {
    decision = 'warn';
    warnings.push(`${pendingResult.count} pending task(s): ${pendingResult.tasks.join(', ')}`);
  }

  if (warnings.length > 0) {
    reason = `Teammate ${teammate} idle with: ${warnings.join('; ')}`;
  }

  // whitebox 이벤트 로깅
  await emitHookDecision(input, {
    hook: 'teammate-idle-gate',
    decision,
    severity: decision === 'warn' ? 'warning' : 'info',
    summary: reason || `Teammate ${teammate} idle — no governance issues`,
    remediation: decision === 'warn'
      ? 'Review pending tasks and escalated requests before allowing extended idle.'
      : '',
  });

  // stdout에 결정 JSON 출력
  process.stdout.write(JSON.stringify({
    decision,
    reason,
    teammate,
    checks: {
      pendingTasks: pendingResult,
      escalatedRequests: escalatedResult,
    },
  }));
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[teammate-idle-gate] Unhandled error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    GOVERNANCE_POLICIES,
    checkPendingTasks,
    checkEscalatedRequests,
  };
}
