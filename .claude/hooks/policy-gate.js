#!/usr/bin/env node
/**
 * Integrated Hook: Policy Gate
 *
 * Combines permission-checker (PreToolUse) + standards-validator (PostToolUse)
 * into a unified policy enforcement pipeline.
 *
 * Phase 2 Hook Consolidation - Replaces individual hooks
 *
 * Mode Detection:
 *   - PreToolUse: Permission checking (block unauthorized writes)
 *   - PostToolUse: Standards validation (report violations)
 *
 * Claude Code Hook Protocol:
 *   - stdin: JSON { hook_event_name, tool_name, tool_input, tool_result? }
 *   - stdout: JSON { decision: "allow"|"deny", reason? } (PreToolUse)
 *            or { hookSpecificOutput: { additionalContext } } (PostToolUse)
 */

const path = require('path');
const AgentAuthService = require('../services/auth');
const { emitHookDecision } = require('./lib/hook-decision-event');
const {
  resolveTokenSecret
} = AgentAuthService;
const {
  resolveRoleIdentity,
  resolveDeterministicWriteScope,
  matchesAnyPattern: sharedMatchesAnyPattern,
  checkDomainBoundary,
  normalizeRole
} = require('./lib/deterministic-policy');

// ---------------------------------------------------------------------------
// 1. Standards Rules (from standards-validator.js - simplified)
// ---------------------------------------------------------------------------

const FORBIDDEN_PATTERNS = [
  {
    id: 'any-type',
    extensions: ['.ts', '.tsx'],
    patterns: [/:\s*any\b/, /\bas\s+any\b/],
    severity: 'error',
    message: 'Usage of "any" type is forbidden. Use proper types or "unknown".'
  },
  {
    id: 'console-log',
    extensions: ['.js', '.jsx', '.ts', '.tsx'],
    patterns: [/\bconsole\.(log|debug|info)\s*\(/],
    severity: 'warning',
    message: 'console.log is forbidden in production. Use structured logging.'
  },
  {
    id: 'inline-style',
    extensions: ['.jsx', '.tsx'],
    patterns: [/style\s*=\s*\{\s*\{/],
    severity: 'error',
    message: 'Inline styles are forbidden. Use CSS classes or styled-components.'
  },
  {
    id: 'hardcoded-secret',
    extensions: ['.js', '.ts', '.jsx', '.tsx', '.py'],
    patterns: [/(password|secret|api_key)\s*=\s*['"][^'"]{8,}['"]/i],
    severity: 'error',
    message: 'Hardcoded secrets detected. Use environment variables.'
  }
];

const NAMING_RULES = {
  python: {
    file: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/,
    className: /^[A-Z][a-zA-Z0-9]*$/,
    function: /^[a-z][a-z0-9]*(_[a-z0-9]+)*$/
  },
  javascript: {
    file: /^[a-z][a-z0-9]*([._-][a-z0-9]+)*$/,
    className: /^[A-Z][a-zA-Z0-9]*$/,
    function: /^[a-z][a-zA-Z0-9]*$/
  },
  component: {
    file: /^[A-Z][a-zA-Z0-9]*$/
  }
};

// ---------------------------------------------------------------------------
// 2. Path Matching Utilities
// ---------------------------------------------------------------------------

function globToRegex(pattern) {
  let regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*');
  return new RegExp('^' + regex + '$');
}

function matchesAnyPattern(relativePath, patterns) {
  return sharedMatchesAnyPattern(relativePath, patterns);
}

function toRelativePath(filePath) {
  if (!filePath) return '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(projectDir, filePath);
  if (relative.startsWith('..')) return relative;
  return relative;
}

// ---------------------------------------------------------------------------
// 3. Permission Check (PreToolUse)
// ---------------------------------------------------------------------------

function checkPermission(role, relativePath) {
  const identity = resolveRoleIdentity(role);
  if (!identity.recognized) {
    return {
      allowed: false,
      reason: `Unknown role "${role}" has no deterministic write scope.`
    };
  }

  const boundary = checkDomainBoundary(relativePath, identity.domain);
  if (boundary.violation) {
    return {
      allowed: false,
      reason: `Role "${role}" cannot write across domain boundary to "${relativePath}".`
    };
  }

  const scope = resolveDeterministicWriteScope({ identity, relativePath });
  if (scope.writePaths.length > 0 && matchesAnyPattern(relativePath, scope.writePaths)) {
    return { allowed: true };
  }

  return {
    allowed: false,
    reason: `Role "${role}" cannot write to "${relativePath}" (${scope.source}).`
  };
}

// ---------------------------------------------------------------------------
// 4. Standards Validation (PostToolUse)
// ---------------------------------------------------------------------------

function validateContent(content, filePath) {
  const violations = [];
  const ext = path.extname(filePath);
  const lines = content.split('\n');

  // Check forbidden patterns
  for (const rule of FORBIDDEN_PATTERNS) {
    if (!rule.extensions.includes(ext)) continue;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Skip comments
      if (line.trim().startsWith('//') || line.trim().startsWith('#')) continue;

      for (const pattern of rule.patterns) {
        if (pattern.test(line)) {
          violations.push({
            type: 'forbidden',
            severity: rule.severity,
            message: rule.message,
            file: filePath,
            line: lineNum
          });
          break;
        }
      }
    }
  }

  // Check naming conventions
  const fileName = path.basename(filePath, ext);
  const isComponent = ['.tsx', '.jsx'].includes(ext);

  if (ext === '.py') {
    if (!NAMING_RULES.python.file.test(fileName) && !fileName.startsWith('__')) {
      violations.push({
        type: 'naming',
        severity: 'warning',
        message: `Python file "${fileName}" should use snake_case.`,
        file: filePath
      });
    }
  } else if (isComponent) {
    if (!NAMING_RULES.component.file.test(fileName) && !NAMING_RULES.javascript.file.test(fileName)) {
      violations.push({
        type: 'naming',
        severity: 'warning',
        message: `Component file "${fileName}" should use PascalCase.`,
        file: filePath
      });
    }
  }

  return violations;
}

function formatViolationReport(violations, filePath) {
  if (violations.length === 0) return '';

  const errors = violations.filter(v => v.severity === 'error');
  const warnings = violations.filter(v => v.severity === 'warning');

  let report = `\n[Policy Gate] ${violations.length} issue(s) in "${filePath}"`;
  report += `\n  Errors: ${errors.length} | Warnings: ${warnings.length}\n`;

  for (const v of violations) {
    const severity = v.severity === 'error' ? '[ERROR]' : '[WARN]';
    const lineRef = v.line ? ` (line ${v.line})` : '';
    report += `  ${severity}${lineRef} ${v.message}\n`;
  }

  return report;
}

// ---------------------------------------------------------------------------
// 5. Main Entry Point
// ---------------------------------------------------------------------------

function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        resolve(data.trim() ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

async function main() {
  const input = await readStdin();
  const hookEvent = input.hook_event_name || '';
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || '';

  if (!filePath) {
    await emitHookDecision(input, {
      hook: 'policy-gate',
      decision: 'skip',
      summary: 'No target file path provided.',
    });
    return;
  }

  const relativePath = toRelativePath(filePath);
  if (relativePath.startsWith('..')) {
    await emitHookDecision(input, {
      hook: 'policy-gate',
      decision: 'skip',
      summary: 'Target path is outside project scope.',
    });
    return;
  }

  // Detect agent role
  const agentRole = normalizeRole(process.env.CLAUDE_AGENT_ROLE);
  const agentToken = toolInput.agent_token || process.env.CLAUDE_AGENT_TOKEN || '';

  // PreToolUse: Permission check
  if (hookEvent.startsWith('PreToolUse')) {
    let permissionResult = null;

    if (agentToken) {
      const auth = new AgentAuthService({ secretKey: resolveTokenSecret() });
      const verified = auth.verifyToken(agentToken);

      if (!verified.valid) {
        permissionResult = {
          allowed: false,
          reason: 'Invalid agent authentication token for policy gate.'
        };
      } else {
        const identity = resolveRoleIdentity(verified.role);
        if (!identity.recognized) {
          permissionResult = {
            allowed: false,
            reason: `Unknown authenticated role "${verified.role}" has no deterministic write scope.`
          };
        } else {
          const boundary = checkDomainBoundary(relativePath, identity.domain || verified.domain);
          if (boundary.violation) {
            permissionResult = {
              allowed: false,
              reason: `Role "${verified.role}" cannot write across domain boundary to "${relativePath}".`
            };
          } else {
            const scope = resolveDeterministicWriteScope({
              identity,
              allowedPaths: verified.allowedPaths,
              reviewOnly: verified.reviewOnly,
              selfCheck: toolInput.self_check === true,
              changedFiles: toolInput.changed_files || toolInput.changedFiles,
              relativePath
            });

            permissionResult = scope.writePaths.length > 0 && matchesAnyPattern(relativePath, scope.writePaths)
              ? { allowed: true }
              : {
                allowed: false,
                reason: `Write to "${relativePath}" is outside the deterministic write scope for role "${verified.role}" (${scope.source}).`
              };
          }
        }
      }
    } else if (agentRole) {
      permissionResult = checkPermission(agentRole, relativePath);
    }

    if (permissionResult && !permissionResult.allowed) {
      await emitHookDecision(input, {
        hook: 'policy-gate',
        decision: 'block',
        severity: 'error',
        summary: 'Write denied by role policy.',
        remediation: 'Request an authorized role or target an allowed path.',
      });
      process.stdout.write(JSON.stringify({
        decision: 'block',
        reason: permissionResult.reason
      }));
      return;
    }
    await emitHookDecision(input, {
      hook: 'policy-gate',
      decision: 'approve',
      severity: 'info',
      summary: 'Write allowed by policy checks.',
    });
    // Allow by default
    return;
  }

  // PostToolUse: Standards validation
  if (hookEvent.startsWith('PostToolUse')) {
    const content = toolInput.content || toolInput.new_string || '';
    if (!content) {
      await emitHookDecision(input, {
        hook: 'policy-gate',
        decision: 'skip',
        summary: 'No content provided for standards validation.',
      });
      return;
    }

    const violations = validateContent(content, relativePath);
    if (violations.length > 0) {
      const report = formatViolationReport(violations, relativePath);
      const hasError = violations.some((v) => v.severity === 'error');
      await emitHookDecision(input, {
        hook: 'policy-gate',
        decision: 'warn',
        severity: hasError ? 'error' : 'warning',
        summary: `${violations.length} standards issue(s) detected.`,
        remediation: 'Review policy warnings before continuing.',
      });
      process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
          additionalContext: report,
          hookEventName: hookEvent
        }
      }));
    } else {
      await emitHookDecision(input, {
        hook: 'policy-gate',
        decision: 'approve',
        severity: 'info',
        summary: 'Standards validation passed.',
      });
    }
    return;
  }

  await emitHookDecision(input, {
    hook: 'policy-gate',
    decision: 'skip',
    summary: 'Unsupported hook event.',
  });
}

main().catch((err) => { console.error('[policy-gate] Unhandled error:', err.message); });

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    FORBIDDEN_PATTERNS,
    checkPermission,
    validateContent,
    formatViolationReport,
    matchesAnyPattern,
    globToRegex
  };
}
