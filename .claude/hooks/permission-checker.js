#!/usr/bin/env node
/**
 * PreToolUse[Edit|Write] Hook: Permission Checker
 *
 * Validates agent file access permissions based on role-specific
 * access_rights matrix. Blocks unauthorized writes and provides
 * clear guidance on proper escalation paths.
 *
 * v2.0.0: JWT token support added (backward compatible with legacy tokens)
 *
 * @TASK P2-T1 - Agent Permission Checker Hook
 * @SPEC project-team/agents/*.md (access_rights sections)
 *
 * Claude Code Hook Protocol:
 *   - stdin: JSON { tool_name, tool_input: { file_path, ... } }
 *   - stdout: JSON { decision: "allow"|"deny", reason?: string }
 *             or { hookSpecificOutput: { additionalContext: string } }
 *
 * Agent Authentication:
 *   The current agent identity is established via a signed token.
 *   Supports both legacy tokens and JWT format (from auth.js).
 *
 * Token Formats:
 *   1. Legacy: base64url(payload).base64url(signature)
 *   2. JWT: base64url(header).base64url(payload).base64url(signature)
 */

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const AgentAuthService = require('../services/auth');
const {
  globToRegex: sharedGlobToRegex,
  matchesAnyPattern: sharedMatchesAnyPattern,
  resolveRoleIdentity,
  resolveDeterministicWriteScope,
  checkDomainBoundary: sharedCheckDomainBoundary
} = require('./lib/deterministic-policy');

const {
  resolveTokenSecret,
  normalizeTokenExpiration,
  isTokenExpired
} = AgentAuthService;

// ---------------------------------------------------------------------------
// 0. Agent Authentication (Signed Token)
// ---------------------------------------------------------------------------

function base64UrlEncode(buffer) {
  return Buffer.from(buffer)
    .toString('base64')
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

function base64UrlDecodeToBuffer(str) {
  if (typeof str !== 'string' || str.length === 0) {
    throw new Error('Invalid base64url string');
  }
  if (!/^[A-Za-z0-9_-]+$/.test(str)) {
    throw new Error('Invalid base64url characters');
  }

  const padded = str + '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = padded.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function signAgentTokenPayload(payloadB64, secret) {
  return base64UrlEncode(
    crypto.createHmac('sha256', secret).update(payloadB64).digest()
  );
}

/**
 * Verify a signed agent token.
 * Token format: base64url(JSON(payload)).base64url(HMAC_SHA256(payloadB64, secret))
 * Payload: { role: string, exp: number (unix seconds) }
 *
 * @param {string} token
 * @param {string} secret
 * @param {number} [nowMs]
 * @returns {{ ok: true, role: string } | { ok: false, reason: string }}
 */
function verifyAgentToken(token, secret, nowMs = Date.now()) {
  const resolvedSecret = secret === undefined ? resolveTokenSecret() : secret;

  if (!resolvedSecret) {
    return { ok: false, reason: 'Missing token verification secret (CLAUDE_HOOK_SECRET, AGENT_JWT_SECRET, or PERMISSION_CHECKER_SECRET).' };
  }
  if (!token || typeof token !== 'string') {
    return { ok: false, reason: 'Missing agent authentication token (CLAUDE_AGENT_TOKEN or tool_input.agent_token).' };
  }

  // v2.0.0: Detect token format (legacy vs JWT)
  const parts = token.split('.');

  if (parts.length === 3) {
    // JWT format: header.payload.signature
    return verifyJWTToken(token, resolvedSecret, nowMs);
  } else if (parts.length === 2) {
    // Legacy format: payload.signature
    return verifyLegacyToken(token, resolvedSecret, nowMs);
  } else {
    return { ok: false, reason: 'Invalid agent_token format (expected JWT or legacy "payload.signature").' };
  }
}

function buildVerifiedTokenResult(payload, role) {
  const result = {
    ok: true,
    role: role.toLowerCase().replace(/\s+/g, '-')
  };

  if (typeof payload.domain === 'string' && payload.domain.trim() !== '') {
    result.domain = payload.domain;
  }

  if (typeof payload.scope_id === 'string' && payload.scope_id.trim() !== '') {
    result.scopeId = payload.scope_id;
  }

  if (Array.isArray(payload.allowed_paths)) {
    result.allowedPaths = payload.allowed_paths;
  }

  if (typeof payload.review_only === 'boolean') {
    result.reviewOnly = payload.review_only;
  }

  if (payload.agentId) {
    result.agentId = payload.agentId;
  }

  if (payload.type) {
    result.type = payload.type;
  }

  if (payload.requestor) {
    result.requestor = payload.requestor;
  }

  if (payload.target) {
    result.target = payload.target;
  }

  if (payload.reason) {
    result.reasonText = payload.reason;
  }

  if (Array.isArray(payload.allowed_tools)) {
    result.allowedTools = payload.allowed_tools;
  }

  if (Array.isArray(payload.denied_tools)) {
    result.deniedTools = payload.denied_tools;
  }

  if (typeof payload.advisory_only === 'boolean') {
    result.advisoryOnly = payload.advisory_only;
  }

  if (typeof payload.iat === 'number' && Number.isFinite(payload.iat)) {
    result.iat = payload.iat;
  }

  const normalizedExp = normalizeTokenExpiration(payload.exp);
  if (normalizedExp !== null) {
    result.exp = normalizedExp;
  }

  return result;
}

/**
 * Verify JWT format token (v2.0.0)
 * @param {string} token - JWT token
 * @param {string} secret - Secret key
 * @param {number} nowMs - Current timestamp
 * @returns {{ ok: boolean, role?: string, reason?: string }}
 */
function verifyJWTToken(token, secret, nowMs) {
  const parts = token.split('.');
  if (parts.length !== 3) {
    return { ok: false, reason: 'Invalid JWT format (expected 3 parts).' };
  }

  const [headerEncoded, payloadEncoded, signature] = parts;

  // Verify signature
  let expectedSig;
  try {
    const data = `${headerEncoded}.${payloadEncoded}`;
    expectedSig = base64UrlEncode(
      crypto.createHmac('sha256', secret).update(data).digest()
    );
  } catch {
    return { ok: false, reason: 'Failed to compute JWT signature.' };
  }

  try {
    const a = Buffer.from(signature);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) {
      return { ok: false, reason: 'Invalid JWT signature.' };
    }
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid JWT signature.' };
    }
  } catch {
    return { ok: false, reason: 'Invalid JWT signature.' };
  }

  // Decode payload
  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToBuffer(payloadEncoded).toString('utf8'));
  } catch {
    return { ok: false, reason: 'Invalid JWT payload.' };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'Invalid JWT payload.' };
  }

  // Check role
  const exp = normalizeTokenExpiration(payload.exp);
  if (exp === null) {
    return { ok: false, reason: 'JWT payload missing exp.' };
  }

  if (isTokenExpired(payload.exp, nowMs)) {
    return { ok: false, reason: 'JWT token has expired.' };
  }

  const role = payload.role || payload.agentId?.role;
  if (payload.type === 'escalation' && (typeof role !== 'string' || role.trim() === '')) {
    return buildVerifiedTokenResult(payload, 'escalation');
  }

  if (typeof role !== 'string' || role.trim() === '') {
    return { ok: false, reason: 'JWT payload missing role.' };
  }

  return buildVerifiedTokenResult(payload, role);
}

/**
 * Verify legacy format token (v1.x)
 * @param {string} token - Legacy token
 * @param {string} secret - Secret key
 * @param {number} nowMs - Current timestamp
 * @returns {{ ok: boolean, role?: string, reason?: string }}
 */
function verifyLegacyToken(token, secret, nowMs) {
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, reason: 'Invalid legacy token format (expected "payload.signature").' };
  }

  const [payloadB64, signatureB64] = parts;

  let expectedSig;
  try {
    expectedSig = signAgentTokenPayload(payloadB64, secret);
  } catch {
    return { ok: false, reason: 'Failed to compute token signature.' };
  }

  try {
    const a = Buffer.from(signatureB64);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length) {
      return { ok: false, reason: 'Invalid agent_token signature.' };
    }
    if (!crypto.timingSafeEqual(a, b)) {
      return { ok: false, reason: 'Invalid agent_token signature.' };
    }
  } catch {
    return { ok: false, reason: 'Invalid agent_token signature.' };
  }

  let payload;
  try {
    payload = JSON.parse(base64UrlDecodeToBuffer(payloadB64).toString('utf8'));
  } catch {
    return { ok: false, reason: 'Invalid token payload.' };
  }

  if (!payload || typeof payload !== 'object') {
    return { ok: false, reason: 'Invalid token payload.' };
  }
  if (typeof payload.role !== 'string' || payload.role.trim() === '') {
    return { ok: false, reason: 'Token payload missing role.' };
  }
  const exp = normalizeTokenExpiration(payload.exp);
  if (exp === null) {
    return { ok: false, reason: 'Token payload missing exp.' };
  }

  if (isTokenExpired(payload.exp, nowMs)) {
    return { ok: false, reason: 'Token has expired.' };
  }

  return buildVerifiedTokenResult(payload, payload.role);
}

function resolveVerifiedRoleContext(verified) {
  const identity = resolveRoleIdentity(verified.role);
  if (identity.recognized) {
    return {
      role: identity.compatibilityAlias || identity.canonicalRole,
      canonicalRole: identity.canonicalRole,
      domain: identity.domain || verified.domain || null,
      originalRole: identity.normalizedRole || verified.role
    };
  }

  return {
    role: null,
    canonicalRole: null,
    domain: verified.domain || null
  };
}

// ---------------------------------------------------------------------------
// 0b. Safe Path Resolution (realpath-based)
// ---------------------------------------------------------------------------

function realpathNative(p) {
  const fn = fs.realpathSync.native ? fs.realpathSync.native : fs.realpathSync;
  return fn(p);
}

/**
 * Resolve a tool file path to a normalized project-relative path.
 * Rejects traversal and symlink-escape using realpath checks.
 *
 * @param {string} filePath
 * @param {string} projectDir
 * @returns {{ ok: true, relativePath: string } | { ok: false, reason: string }}
 */
function toSafeProjectRelativePath(filePath, projectDir) {
  if (!filePath) return { ok: false, reason: 'Missing file_path in tool input.' };

  const projectRootAbs = path.resolve(projectDir || process.cwd());

  let projectRootReal;
  try {
    projectRootReal = realpathNative(projectRootAbs);
  } catch {
    return { ok: false, reason: `Project root is not accessible: "${projectRootAbs}".` };
  }

  const absTarget = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRootAbs, filePath);

  let targetReal;
  try {
    targetReal = realpathNative(absTarget);
  } catch {
    // If the target file doesn't exist yet (e.g., Write), resolve its parent directory.
    const parentAbs = path.dirname(absTarget);
    let parentReal;
    try {
      parentReal = realpathNative(parentAbs);
    } catch {
      return { ok: false, reason: `Target path parent is not accessible: "${parentAbs}".` };
    }
    targetReal = path.join(parentReal, path.basename(absTarget));
  }

  const rel = path.relative(projectRootReal, targetReal);
  if (rel.startsWith('..') || path.isAbsolute(rel)) {
    return { ok: false, reason: 'Path escapes project root (traversal or symlink escape).' };
  }

  const normalized = rel.split(path.sep).join('/');
  return { ok: true, relativePath: normalized };
}


// ---------------------------------------------------------------------------
// 1. Permission Matrix
//    Derived from agents/*.md access_rights YAML blocks.
//    Patterns use minimatch-style globs (implemented with simple matching).
// ---------------------------------------------------------------------------

const PERMISSION_MATRIX = {
  'project-manager': {
    read: ['**/*'],
    write: [
      'management/requests/to-*/**',
      'management/meetings/**',
      'management/decisions/**'
    ],
    cannot: [
      'src/**',            // No direct code modification
      'contracts/standards/**', // Chief Architect's domain
      'design/**',         // Chief Designer's domain
      'database/**',       // DBA's domain
      'qa/**'              // QA Manager's domain
    ],
    escalation: {
      'src/**': 'Domain Part Leader/Developer',
      'contracts/standards/**': 'Chief Architect',
      'design/**': 'Chief Designer',
      'database/**': 'DBA'
    }
  },

  'chief-architect': {
    read: ['**/*'],
    write: [
      'contracts/standards/**',
      'management/decisions/**'
    ],
    veto: [
      'architecture-violation',
      'tech-standard-violation',
      'security-vulnerability'
    ],
    cannot: [
      'src/**',            // No direct code implementation
      'design/**',         // Chief Designer's domain
      'database/schema/**' // DBA's domain (schema files)
    ],
    escalation: {
      'src/**': 'Domain Developer',
      'design/**': 'Chief Designer',
      'database/schema/**': 'DBA'
    }
  },

  'chief-designer': {
    read: ['**/*'],
    write: [
      'contracts/standards/design-system.md',
      'design/**'
    ],
    veto: [
      'design-guide-violation',
      'inconsistent-ui'
    ],
    cannot: [
      'src/**',
      'contracts/standards/coding-standards.md',
      'contracts/standards/api-standards.md',
      'contracts/standards/database-standards.md',
      'database/**'
    ],
    escalation: {
      'src/**': 'Domain Developer',
      'contracts/standards/coding-standards.md': 'Chief Architect',
      'database/**': 'DBA'
    }
  },

  'dba': {
    read: ['**/*'],
    write: [
      'contracts/standards/database-standards.md',
      'database/schema/**',
      'database/**'
    ],
    veto: [
      'data-standard-violation',
      'dangerous-migration',
      'performance-issue-schema'
    ],
    cannot: [
      'src/**/services/**',
      'src/**/routes/**',
      'design/**'
    ],
    escalation: {
      'src/**': 'Domain Developer',
      'design/**': 'Chief Designer'
    }
  },

  'qa-manager': {
    read: ['**/*'],
    write: [
      'qa/**',
      'management/responses/from-qa/**'
    ],
    veto: [
      'quality-gate-fail',
      'coverage-insufficient',
      'critical-bug-exists'
    ],
    cannot: [
      'src/**',
      'contracts/standards/**',
      'design/**',
      'database/schema/**'
    ],
    escalation: {
      'src/**': 'Domain Developer (via bug report)',
      'contracts/standards/**': 'Chief Architect',
      'design/**': 'Chief Designer'
    }
  },

  'maintenance-analyst': {
    read: ['**/*'],
    write: [
      'docs/architecture/**',
      'docs/changelog/**',
      'docs/dependencies/**',
      '.claude/architecture/**',
      '.claude/changelog/**',
      '.claude/risk-areas.yaml'
    ],
    cannot: [
      'src/**',
      'contracts/**',
      'design/**',
      'database/schema/**'
    ],
    escalation: {
      'src/**': 'Domain Developer',
      'contracts/**': 'Chief Architect',
      'design/**': 'Chief Designer'
    }
  },

  // Template-based roles: Part Leader, Domain Designer, Domain Developer
  // These are identified by pattern: "{domain}-part-leader", "{domain}-designer", "{domain}-developer"
};

// ---------------------------------------------------------------------------
// 2. Template Role Generators
//    For domain-scoped agents, we generate permissions dynamically.
// ---------------------------------------------------------------------------

/**
 * Generate permissions for a Part Leader of a specific domain.
 * @param {string} domain - The domain name (e.g., "auth", "payment")
 * @returns {object} Permission configuration
 */
function generatePartLeaderPermissions(domain) {
  return {
    read: [
      '**/*',
      `contracts/interfaces/**`,
      `management/requests/to-${domain}/**`
    ],
    write: [
      `src/domains/${domain}/**`,
      'management/requests/to-*/**',
      `contracts/interfaces/${domain}-api.yaml`,
      `management/responses/from-${domain}/**`
    ],
    cannot: [
      // Other domains' code
      'src/domains/!(' + domain + ')/**',
      'contracts/standards/**',
      'design/**/!(' + domain + ')/**'
    ],
    escalation: {
      'contracts/standards/**': 'Chief Architect',
      'design/**': 'Chief Designer',
      'database/schema/**': 'DBA'
    },
    _domain: domain
  };
}

/**
 * Generate permissions for a Domain Designer.
 * @param {string} domain - The domain name
 * @returns {object} Permission configuration
 */
function generateDomainDesignerPermissions(domain) {
  return {
    read: [
      'contracts/standards/design-system.md',
      'design/**',
      `src/domains/${domain}/**`,
      `contracts/interfaces/${domain}-components.yaml`
    ],
    write: [
      `design/${domain}/**`,
      `contracts/interfaces/${domain}-components.yaml`
    ],
    cannot: [
      'contracts/standards/design-system.md',
      'src/**',
      'database/**'
    ],
    escalation: {
      'contracts/standards/design-system.md': 'Chief Designer',
      'src/**': 'Domain Developer',
      'database/**': 'DBA'
    },
    _domain: domain
  };
}

/**
 * Generate permissions for a Domain Developer.
 * @param {string} domain - The domain name
 * @returns {object} Permission configuration
 */
function generateDomainDeveloperPermissions(domain) {
  return {
    read: [
      `src/domains/${domain}/**`,
      'contracts/standards/**',
      `contracts/interfaces/${domain}-api.yaml`,
      `contracts/interfaces/${domain}-components.yaml`,
      `design/${domain}/**`
    ],
    write: [
      `src/domains/${domain}/**`,
      `tests/${domain}/**`
    ],
    cannot: [
      'contracts/standards/**',
      'design/**',
      'database/schema/**'
    ],
    escalation: {
      'contracts/standards/**': 'Chief Architect',
      'design/**': 'Domain Designer / Chief Designer',
      'database/schema/**': 'DBA'
    },
    _domain: domain
  };
}

// ---------------------------------------------------------------------------
// 3. Path Matching Utilities
// ---------------------------------------------------------------------------

/**
 * Convert a simplified glob pattern to a RegExp.
 * Supports: ** (any depth), * (single segment), specific filenames.
 *
 * @param {string} pattern - Glob-like pattern
 * @returns {RegExp}
 */
function globToRegex(pattern) {
  return sharedGlobToRegex(pattern);
}

/**
 * Check if a relative file path matches any of the given glob patterns.
 * @param {string} relativePath - The file path relative to project root
 * @param {string[]} patterns - Array of glob patterns
 * @returns {boolean}
 */
function matchesAnyPattern(relativePath, patterns) {
  return sharedMatchesAnyPattern(relativePath, patterns);
}

/**
 * Find the best matching escalation target for a file path.
 * @param {string} relativePath
 * @param {object} escalationMap - { pattern: "target agent" }
 * @returns {string|null}
 */
function findEscalationTarget(relativePath, escalationMap) {
  if (!escalationMap) return null;

  for (const [pattern, target] of Object.entries(escalationMap)) {
    const regex = globToRegex(pattern);
    if (regex.test(relativePath)) {
      return target;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// 4. Agent Role Parsing / Detection
// ---------------------------------------------------------------------------

/**
 * Parse an agent role string into {role, domain}.
 * Accepts both static roles (e.g. "project-manager") and domain-scoped
 * roles encoded as "{domain}-developer|designer|part-leader".
 *
 * @param {string|null} agentRole
 * @returns {{ role: string|null, domain: string|null }}
 */
function parseAgentRoleString(agentRole) {
  if (!agentRole) return { role: null, domain: null };

  const roleLower = String(agentRole).toLowerCase().replace(/\s+/g, '-');

  // Check static roles first
  if (PERMISSION_MATRIX[roleLower]) {
    return { role: roleLower, domain: null };
  }

  // Check template-based domain roles
  // Pattern: "{domain}-part-leader", "{domain}-designer", "{domain}-developer"
  const partLeaderMatch = roleLower.match(/^(.+)-part-leader$/);
  if (partLeaderMatch) {
    return { role: 'part-leader', domain: partLeaderMatch[1] };
  }

  const designerMatch = roleLower.match(/^(.+)-designer$/);
  if (designerMatch && designerMatch[1] !== 'chief') {
    return { role: 'domain-designer', domain: designerMatch[1] };
  }

  const developerMatch = roleLower.match(/^(.+)-developer$/);
  if (developerMatch) {
    return { role: 'domain-developer', domain: developerMatch[1] };
  }

  return { role: null, domain: null };
}

/**
 * Detect the current agent role from environment variables.
 *
 * NOTE: This is retained for backwards compatibility and unit tests.
 * The hook's authorization decision should be based on a verified token,
 * not on these environment variables.
 *
 * @returns {{ role: string|null, domain: string|null }}
 */
function detectAgentRole() {
  const agentRole = process.env.CLAUDE_AGENT_ROLE
    || process.env.CLAUDE_AGENT_NAME
    || null;

  return parseAgentRoleString(agentRole);
}

/**
 * Resolve the permission configuration for a detected agent.
 * @param {string} role
 * @param {string|null} domain
 * @returns {object|null}
 */
function resolvePermissions(role, domain) {
  // Static roles
  if (PERMISSION_MATRIX[role]) {
    return PERMISSION_MATRIX[role];
  }

  // Domain-scoped template roles
  if (role === 'part-leader' && domain) {
    return generatePartLeaderPermissions(domain);
  }
  if (role === 'domain-designer' && domain) {
    return generateDomainDesignerPermissions(domain);
  }
  if (role === 'domain-developer' && domain) {
    return generateDomainDeveloperPermissions(domain);
  }

  return null;
}

// ---------------------------------------------------------------------------
// 5. Cross-Domain Boundary Detection
// ---------------------------------------------------------------------------

/**
 * Check if a file path crosses domain boundaries for domain-scoped agents.
 * @param {string} relativePath - File path relative to project root
 * @param {string} agentDomain - The agent's own domain
 * @returns {{ violation: boolean, targetDomain: string|null }}
 */
function checkDomainBoundary(relativePath, agentDomain) {
  return sharedCheckDomainBoundary(relativePath, agentDomain);
}

// ---------------------------------------------------------------------------
// 6. Message Formatting
// ---------------------------------------------------------------------------

/**
 * Format a denial message with clear guidance.
 * @param {object} params
 * @returns {string}
 */
function formatDenialMessage({ agentRole, domain, filePath, reason, escalationTarget }) {
  const agentLabel = domain ? `${domain}-${agentRole}` : agentRole;

  let message = `[Permission Denied] Agent "${agentLabel}" cannot write to "${filePath}".`;
  message += `\n  Reason: ${reason}`;

  if (escalationTarget) {
    message += `\n  Escalation: Request this change through "${escalationTarget}".`;
  }

  return message;
}

/**
 * Format a domain boundary violation message.
 * @param {object} params
 * @returns {string}
 */
function formatBoundaryViolationMessage({ agentRole, agentDomain, targetDomain, filePath }) {
  const agentLabel = `${agentDomain}-${agentRole}`;

  let message = `[Domain Boundary Violation] Agent "${agentLabel}" cannot modify files in domain "${targetDomain}".`;
  message += `\n  File: "${filePath}"`;
  message += `\n  Your domain: "${agentDomain}"`;
  message += `\n  Target domain: "${targetDomain}"`;
  message += `\n  Escalation: Request this change through "${targetDomain}-part-leader" or use the interface request protocol.`;

  return message;
}

/**
 * Format a warning message when agent role is unknown.
 * @param {string} filePath
 * @returns {string}
 */
function formatUnknownAgentWarning(filePath) {
  return `[Permission Warning] Agent role not detected (CLAUDE_AGENT_ROLE not set). `
    + `Unable to verify write permission for "${filePath}". `
    + `Set CLAUDE_AGENT_ROLE environment variable for proper access control.`;
}

// ---------------------------------------------------------------------------
// 7. Core Permission Check Logic
// ---------------------------------------------------------------------------

/**
 * Validate whether the current agent has write permission to the target file.
 *
 * @param {string} role - Agent role identifier
 * @param {string|null} domain - Agent's domain (for domain-scoped roles)
 * @param {string} relativePath - File path relative to project root
 * @returns {{ allowed: boolean, reason?: string, escalation?: string, type?: string }}
 */
function checkPermission(role, domain, relativePath) {
  const permissions = resolvePermissions(role, domain);
  if (!permissions) {
    return {
      allowed: false,
      reason: `Unknown role "${role}" has no defined permissions.`,
      type: 'unknown-role'
    };
  }

  // 1. Check domain boundary violations (highest priority for domain-scoped agents)
  if (domain) {
    const boundary = checkDomainBoundary(relativePath, domain);
    if (boundary.violation) {
      return {
        allowed: false,
        reason: `Domain boundary violation: "${domain}" agent cannot modify "${boundary.targetDomain}" domain files.`,
        escalation: `${boundary.targetDomain}-part-leader`,
        type: 'domain-boundary'
      };
    }
  }

  // 2. Check explicit "cannot" rules
  if (permissions.cannot && matchesAnyPattern(relativePath, permissions.cannot)) {
    const escalation = findEscalationTarget(relativePath, permissions.escalation);
    return {
      allowed: false,
      reason: `File path "${relativePath}" is in a restricted area for role "${role}".`,
      escalation: escalation,
      type: 'restricted-area'
    };
  }

  // 3. Check if file matches allowed write patterns
  if (permissions.write && matchesAnyPattern(relativePath, permissions.write)) {
    return { allowed: true };
  }

  // 4. If not explicitly allowed, deny with escalation guidance
  const escalation = findEscalationTarget(relativePath, permissions.escalation);
  return {
    allowed: false,
    reason: `File path "${relativePath}" is not in the allowed write paths for role "${role}".`,
    escalation: escalation,
    type: 'not-in-write-paths'
  };
}

// ---------------------------------------------------------------------------
// 8. stdin/stdout Helpers (Claude Code Hook Protocol)
// ---------------------------------------------------------------------------

/**
 * Read JSON from stdin.
 * @returns {Promise<object>}
 */
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { data += chunk; });
    process.stdin.on('end', () => {
      try {
        const parsed = data.trim() ? JSON.parse(data) : {};
        resolve(parsed);
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

/**
 * Output a deny decision.
 * @param {string} reason
 */
function outputDeny(reason) {
  process.stdout.write(JSON.stringify({
    decision: 'block',
    reason: reason
  }));
}

// ---------------------------------------------------------------------------
// 9. Relative Path Resolution
// ---------------------------------------------------------------------------

/**
 * Convert an absolute file path to a project-relative path.
 * Uses CLAUDE_PROJECT_DIR or attempts to detect the project root.
 *
 * @param {string} filePath - Absolute or relative file path
 * @returns {string} Project-relative path
 */
function toRelativePath(filePath) {
  if (!filePath) return '';

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  // If already relative, return as-is
  if (!path.isAbsolute(filePath)) return filePath;

  // Convert to relative from project root
  const relative = path.relative(projectDir, filePath);

  // If the relative path goes outside project (starts with ..), return as-is
  if (relative.startsWith('..')) return relative;

  return relative;
}

// ---------------------------------------------------------------------------
// 10. Main Hook Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();

  // Extract file path from tool input
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || '';

  if (!filePath) return; // No file path = nothing to check

  // Authenticate agent identity using signed token
  const agentToken = toolInput.agent_token || process.env.CLAUDE_AGENT_TOKEN || '';
  const tokenSecret = resolveTokenSecret();

  // Agent Teams 호환: 토큰이 없으면 환경변수 기반 역할 감지로 폴백
  // Agent Teams에서는 CLAUDE_AGENT_TOKEN이 설정되지 않으므로
  // 토큰 없이도 기본 권한으로 동작해야 함
  if (!agentToken) {
    const envRole = process.env.CLAUDE_AGENT_ROLE || '';
    if (envRole) {
      // 환경변수에 역할이 있으면 해당 역할 권한 적용 (로깅만, 차단 안함)
      console.error(`[permission-checker] No token, using env role: ${envRole}`);
    }
    // 토큰 없는 환경(Agent Teams 등)에서는 silent approve
    return;
  }

  const verified = verifyAgentToken(agentToken, tokenSecret);
  if (!verified.ok) {
    outputDeny(verified.reason);
    return;
  }

  // Derive role/domain from verified token claim
  const { role, domain } = resolveVerifiedRoleContext(verified);
  if (!role) {
    outputDeny(`Invalid role in agent_token: "${verified.role}".`);
    return;
  }

  // Convert to safe project-relative path (reject traversal & symlink escape)
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const safePath = toSafeProjectRelativePath(filePath, projectDir);
  if (!safePath.ok) {
    outputDeny(safePath.reason);
    return;
  }
  const relativePath = safePath.relativePath;

  const identity = resolveRoleIdentity(verified.role);
  const boundary = checkDomainBoundary(relativePath, identity.domain || domain);
  if (boundary.violation) {
    outputDeny(formatBoundaryViolationMessage({
      agentRole: identity.originalRole || role,
      agentDomain: identity.domain || domain,
      targetDomain: boundary.targetDomain,
      filePath: relativePath
    }));
    return;
  }

  const scope = resolveDeterministicWriteScope({
    identity,
    allowedPaths: verified.allowedPaths,
    reviewOnly: verified.reviewOnly,
    selfCheck: toolInput.self_check === true,
    changedFiles: toolInput.changed_files || toolInput.changedFiles,
    relativePath
  });

  if (!scope.recognized) {
    outputDeny(`Unknown authenticated role in agent_token: "${verified.role}".`);
    return;
  }

  const result = scope.writePaths.length > 0 && matchesAnyPattern(relativePath, scope.writePaths)
    ? { allowed: true }
    : {
      allowed: false,
      reason: `File path "${relativePath}" is not within the deterministic write scope for role "${identity.normalizedRole}" (${scope.source}).`,
      type: 'not-in-write-paths'
    };

  if (result.allowed) {
    // Permission granted - no output (silent allow)
    return;
  }

  // Permission denied - format appropriate message based on violation type
  if (result.type === 'domain-boundary') {
    outputDeny(formatBoundaryViolationMessage({
      agentRole: role,
      agentDomain: domain,
      targetDomain: result.escalation ? result.escalation.replace('-part-leader', '') : 'unknown',
      filePath: relativePath
    }));
  } else {
    outputDeny(formatDenialMessage({
      agentRole: role,
      domain: domain,
      filePath: relativePath,
      reason: result.reason,
      escalationTarget: result.escalation
    }));
  }
}

main().catch((err) => { console.error('[permission-checker] Unhandled error:', err.message); });

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    PERMISSION_MATRIX,
    generatePartLeaderPermissions,
    generateDomainDesignerPermissions,
    generateDomainDeveloperPermissions,
    globToRegex,
    matchesAnyPattern,
    findEscalationTarget,
    detectAgentRole,
    resolvePermissions,
    checkDomainBoundary,
    checkPermission,
    toRelativePath,
    toSafeProjectRelativePath,
    parseAgentRoleString,
    resolveVerifiedRoleContext,
    verifyAgentToken,
    verifyJWTToken,
    verifyLegacyToken,
    formatDenialMessage,
    formatBoundaryViolationMessage,
    formatUnknownAgentWarning
  };
}
