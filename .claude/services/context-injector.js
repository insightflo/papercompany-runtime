'use strict';

const fs = require('fs');
const path = require('path');

const AgentAuthService = require('./auth');
const { readRegistry } = require('../scripts/install-registry');

const CHANGE_SUMMARY_LIMIT = 500;
const REVIEW_INPUT_MODE = 'clean_context';
const RUNTIME_ENV_KEYS = Object.freeze({
  payloadPath: 'CLAUDE_PROJECT_TEAM_RUNTIME_PAYLOAD_PATH',
  scopedToken: 'CLAUDE_PROJECT_TEAM_SCOPED_TOKEN',
  agentToken: 'CLAUDE_AGENT_TOKEN',
  targetRole: 'CLAUDE_PROJECT_TEAM_TARGET_ROLE',
  scopeProfile: 'CLAUDE_PROJECT_TEAM_SCOPE_PROFILE'
});
const REVIEW_ALLOWED_PATHS = Object.freeze([
  'tests/**',
  'docs/**',
  '**/fixtures/**',
  '**/__fixtures__/**',
  '**/__snapshots__/**',
  '**/*.test.*',
  '**/*.spec.*',
  '**/*.snap'
]);
const TOOL_PRESETS = Object.freeze({
  builder: {
    backend: {
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent'],
      deniedTools: ['chrome-devtools', 'playwright']
    },
    frontend: {
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'playwright'],
      deniedTools: ['execute_sql']
    },
    design: {
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'playwright'],
      deniedTools: ['execute_sql', 'db_migrate']
    },
    fullstack: {
      allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Grep', 'Glob', 'Agent', 'playwright'],
      deniedTools: []
    }
  },
  reviewer: {
    default: {
      allowedTools: ['Read', 'Glob', 'Grep', 'Bash', 'Agent', 'Write', 'Edit'],
      deniedTools: ['execute_sql']
    }
  }
});
const DEFAULT_SCOPE_PATHS = Object.freeze({
  backend: ['src/backend/**', 'prisma/**', 'database/**', 'migrations/**'],
  frontend: ['src/frontend/**', 'src/components/**', 'public/**'],
  design: ['design-system/**', 'src/frontend/**'],
  fullstack: ['src/backend/**', 'src/frontend/**', 'prisma/**', 'database/**']
});
const RISK_PATTERNS = Object.freeze([
  { match: /(^|\/)auth(\/|$)/i, riskLevel: 'CRITICAL', severity: 4 },
  { match: /(^|\/)payment(\/|$)/i, riskLevel: 'CRITICAL', severity: 4 },
  { match: /(^|\/)migrations?(\/|$)/i, riskLevel: 'HIGH', severity: 3 },
  { match: /(^|\/)contracts\/interfaces(\/|$)/i, riskLevel: 'HIGH', severity: 3 }
]);

function stableArray(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort();
}

function normalizeRole(value) {
  return String(value || 'builder').trim().toLowerCase();
}

function normalizeProfile(value) {
  const profile = String(value || '').trim().toLowerCase();
  if (['backend', 'frontend', 'design', 'fullstack'].includes(profile)) {
    return profile;
  }
  return null;
}

function sanitizeFileSegment(value) {
  return String(value || 'runtime')
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'runtime';
}

function withFixedNow(nowMs, callback) {
  if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
    return callback();
  }

  const originalNow = Date.now;
  Date.now = () => nowMs;
  try {
    return callback();
  } finally {
    Date.now = originalNow;
  }
}

function inferScopeProfile(task = {}) {
  const explicitProfile = normalizeProfile(task.scope_profile || task.scopeProfile);
  if (explicitProfile) {
    return explicitProfile;
  }

  const domains = stableArray(task.domains);
  if (domains.length > 1 || task.cross_domain === true || task.crossDomain === true) {
    return 'fullstack';
  }

  const pathHints = stableArray([
    ...(Array.isArray(task.changed_paths) ? task.changed_paths : []),
    ...(Array.isArray(task.changedPaths) ? task.changedPaths : []),
    ...(Array.isArray(task.allowed_paths) ? task.allowed_paths : []),
    ...(Array.isArray(task.allowedPaths) ? task.allowedPaths : [])
  ]);
  const joined = pathHints.join('\n');

  if (/design-system|\/design\//i.test(joined)) {
    return 'design';
  }
  if (/src\/frontend|src\/components|public\//i.test(joined)) {
    return 'frontend';
  }
  if (/src\/backend|prisma\/|database\/|migrations?\//i.test(joined)) {
    return 'backend';
  }

  return 'backend';
}

function getDomainCatalog(projectConfig = {}) {
  const domains = Array.isArray(projectConfig.domains) ? projectConfig.domains : [];
  return domains.reduce((catalog, domain) => {
    if (!domain || !domain.name) {
      return catalog;
    }

    catalog[String(domain.name)] = domain;
    return catalog;
  }, {});
}

function deriveAllowedPaths(task = {}, scopeProfile, targetRole, projectConfig = {}) {
  const explicitPaths = stableArray(task.allowed_paths || task.allowedPaths);
  if (explicitPaths.length > 0) {
    return explicitPaths;
  }

  if (targetRole === 'reviewer') {
    return [...REVIEW_ALLOWED_PATHS];
  }

  const catalog = getDomainCatalog(projectConfig);
  const domainPaths = stableArray((task.domains || []).flatMap((domainName) => {
    const domain = catalog[domainName];
    if (!domain || !domain.path) {
      return [];
    }
    return [`${String(domain.path).replace(/\/$/, '')}/**`];
  }));

  if (domainPaths.length > 0) {
    return domainPaths;
  }

  return [...(DEFAULT_SCOPE_PATHS[scopeProfile] || DEFAULT_SCOPE_PATHS.backend)];
}

function deriveContracts(task = {}, projectConfig = {}) {
  const explicitContracts = stableArray(task.contracts);
  if (explicitContracts.length > 0) {
    return explicitContracts;
  }

  const catalog = getDomainCatalog(projectConfig);
  const domainContracts = stableArray((task.domains || []).flatMap((domainName) => {
    const domain = catalog[domainName];
    if (domain && domain.resources && domain.resources.api_contract) {
      return [domain.resources.api_contract];
    }
    if (domain && domain.api_contract) {
      return [domain.api_contract];
    }
    if (domainName) {
      return [`contracts/interfaces/${domainName}-api.yaml`];
    }
    return [];
  }));

  return domainContracts;
}

function inferRiskLevel(task = {}, allowedPaths = [], contracts = []) {
  const explicitRisk = String(task.risk_level || task.riskLevel || '').trim().toUpperCase();
  if (explicitRisk) {
    return explicitRisk;
  }

  const candidates = stableArray([
    ...(Array.isArray(task.changed_paths) ? task.changed_paths : []),
    ...(Array.isArray(task.changedPaths) ? task.changedPaths : []),
    ...allowedPaths,
    ...contracts
  ]);

  let bestMatch = null;
  for (const candidate of candidates) {
    for (const pattern of RISK_PATTERNS) {
      if (pattern.match.test(candidate)) {
        if (!bestMatch || pattern.severity > bestMatch.severity) {
          bestMatch = pattern;
        }
      }
    }
  }

  if (bestMatch) {
    return bestMatch.riskLevel;
  }

  if ((task.domains || []).length > 1 || task.cross_domain === true || task.crossDomain === true) {
    return 'MEDIUM';
  }

  return 'LOW';
}

function resolveToolContract(targetRole, scopeProfile) {
  if (targetRole === 'reviewer') {
    return TOOL_PRESETS.reviewer.default;
  }

  return TOOL_PRESETS.builder[scopeProfile] || TOOL_PRESETS.builder.backend;
}

function buildPromptPayload(task, payload, registry) {
  return {
    task_id: payload.task_id,
    target_role: payload.target_role,
    target_description: registry.roles[payload.target_role]
      ? registry.roles[payload.target_role].displayName
      : payload.target_role,
    title: task.title || task.description || payload.task_id,
    summary: String(task.summary || task.description || '').trim(),
    domains: stableArray(task.domains),
    artifact_first: true,
    constraints: {
      scope_profile: payload.scope_profile,
      allowed_paths: payload.allowed_paths,
      allowed_tools: payload.allowed_tools,
      denied_tools: payload.denied_tools,
      review_only: payload.review_only,
      risk_level: payload.risk_level,
      contracts: payload.contracts,
      change_summary_limit: payload.change_summary_limit,
      review_input_mode: payload.review_input_mode
    }
  };
}

function buildRuntimePayload(task, options = {}) {
  const registry = options.registry || readRegistry();
  const targetRole = normalizeRole(options.targetRole || task.target_role || task.targetRole);
  if (!['builder', 'reviewer'].includes(targetRole)) {
    throw new Error(`Unsupported target role: ${targetRole}`);
  }

  const taskId = String(task.task_id || task.taskId || '').trim();
  if (!taskId) {
    throw new Error('task_id is required');
  }

  const scopeProfile = inferScopeProfile(task);
  const allowedPaths = deriveAllowedPaths(task, scopeProfile, targetRole, options.projectConfig);
  const contracts = deriveContracts(task, options.projectConfig);
  const riskLevel = inferRiskLevel(task, allowedPaths, contracts);
  const toolContract = resolveToolContract(targetRole, scopeProfile);
  const payload = {
    contract_version: 'v1',
    delivery_mechanism: 'file_env',
    advisory_only: true,
    task_id: taskId,
    target_role: targetRole,
    scope_profile: scopeProfile,
    allowed_paths: allowedPaths,
    allowed_tools: [...toolContract.allowedTools],
    denied_tools: [...toolContract.deniedTools],
    review_only: targetRole === 'reviewer',
    risk_level: riskLevel,
    contracts,
    change_summary_limit: CHANGE_SUMMARY_LIMIT,
    review_input_mode: REVIEW_INPUT_MODE
  };

  payload.prompt_payload = buildPromptPayload(task, payload, registry);
  return payload;
}

function issueScopedToken(payload, options = {}) {
  const auth = options.authService || new AgentAuthService({ secretKey: options.secretKey });
  const primaryDomain = payload.scope_profile === 'fullstack'
    ? 'cross-domain'
    : payload.scope_profile;

  return withFixedNow(options.nowMs, () => auth.issueToken(
    `${payload.target_role}-${payload.task_id}`,
    payload.target_role === 'reviewer' ? 'reviewer' : `builder-${payload.scope_profile}`,
    primaryDomain,
    3600000,
    {
      expiresInSeconds: options.expiresInSeconds,
      scopeId: `${payload.task_id}:${payload.target_role}:${payload.scope_profile}`,
      allowedPaths: payload.allowed_paths,
      reviewOnly: payload.review_only,
      allowedTools: payload.allowed_tools,
      deniedTools: payload.denied_tools,
      advisoryOnly: true,
      extraClaims: {
        task_id: payload.task_id,
        scope_profile: payload.scope_profile,
        risk_level: payload.risk_level,
        contracts: payload.contracts,
        change_summary_limit: payload.change_summary_limit,
        review_input_mode: payload.review_input_mode
      }
    }
  ));
}

function writeRuntimePayload(payload, options = {}) {
  const projectRoot = options.projectRoot || process.cwd();
  const runtimeDir = options.runtimeDir || path.join(projectRoot, '.claude', 'project-team', 'runtime');
  fs.mkdirSync(runtimeDir, { recursive: true });

  const fileName = options.fileName || `${sanitizeFileSegment(payload.task_id)}--${sanitizeFileSegment(payload.target_role)}.json`;
  const payloadPath = path.join(runtimeDir, fileName);
  fs.writeFileSync(payloadPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');

  return payloadPath;
}

function buildRuntimeHandoff(task, options = {}) {
  const payload = buildRuntimePayload(task, options);
  const scopedToken = issueScopedToken(payload, options);
  const payloadPath = writeRuntimePayload(payload, options);
  const env = {
    [RUNTIME_ENV_KEYS.payloadPath]: payloadPath,
    [RUNTIME_ENV_KEYS.scopedToken]: scopedToken,
    [RUNTIME_ENV_KEYS.agentToken]: scopedToken,
    [RUNTIME_ENV_KEYS.targetRole]: payload.target_role,
    [RUNTIME_ENV_KEYS.scopeProfile]: payload.scope_profile
  };

  return {
    payload,
    payloadPath,
    scopedToken,
    env,
    delivery: {
      mechanism: 'file_env',
      runtime_dir: path.dirname(payloadPath),
      payload_path: payloadPath,
      env
    }
  };
}

module.exports = {
  CHANGE_SUMMARY_LIMIT,
  REVIEW_INPUT_MODE,
  REVIEW_ALLOWED_PATHS,
  RUNTIME_ENV_KEYS,
  TOOL_PRESETS,
  buildRuntimePayload,
  buildRuntimeHandoff,
  deriveAllowedPaths,
  deriveContracts,
  inferRiskLevel,
  inferScopeProfile,
  issueScopedToken,
  writeRuntimePayload
};
