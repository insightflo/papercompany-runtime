const fs = require('fs');
const path = require('path');

const REGISTRY_PATH = path.join(__dirname, '..', '..', 'config', 'topology-registry.json');

const CANONICAL_WRITE_PATHS = {
  lead: [],
  builder: ['src/**', 'tests/**'],
  reviewer: [],
  designer: ['design/**', 'contracts/interfaces/**/*components*.yaml'],
  dba: ['database/**', 'migrations/**', 'prisma/**'],
  'security-specialist': ['security/**', 'docs/security/**', '.claude/security/**']
};

function loadTopologyRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function normalizeRole(rawRole) {
  if (!rawRole) {
    return '';
  }

  return String(rawRole).toLowerCase().trim().replace(/\s+/g, '-');
}

function buildAliasLookup(registry) {
  const aliases = new Map();

  for (const role of Object.keys(registry.roles || {})) {
    aliases.set(role, { canonicalRole: role, aliasType: 'canonical' });
  }

  for (const entry of registry.legacyAliases?.agents || []) {
    aliases.set(entry.alias, {
      canonicalRole: entry.canonicalRole,
      compatibilityAlias: entry.alias,
      aliasType: 'legacy-agent'
    });
  }

  for (const entry of registry.legacyAliases?.profiles || []) {
    aliases.set(entry.alias, {
      canonicalRole: entry.canonicalRole,
      compatibilityAlias: entry.alias,
      aliasType: 'legacy-profile'
    });
  }

  return aliases;
}

function resolveRoleIdentity(rawRole, registry = loadTopologyRegistry()) {
  const normalizedRole = normalizeRole(rawRole);
  if (!normalizedRole) {
    return {
      rawRole: rawRole || null,
      normalizedRole,
      recognized: false,
      canonicalRole: null,
      compatibilityAlias: null,
      domain: null
    };
  }

  const aliases = buildAliasLookup(registry);
  const directMatch = aliases.get(normalizedRole);
  if (directMatch) {
    return {
      rawRole,
      normalizedRole,
      recognized: true,
      canonicalRole: directMatch.canonicalRole,
      compatibilityAlias: directMatch.compatibilityAlias || null,
      domain: null,
      aliasType: directMatch.aliasType
    };
  }

  const partLeaderMatch = normalizedRole.match(/^(.+)-part-leader$/);
  if (partLeaderMatch) {
    return {
      rawRole,
      normalizedRole,
      recognized: true,
      canonicalRole: 'lead',
      compatibilityAlias: 'part-leader',
      domain: partLeaderMatch[1],
      aliasType: 'legacy-profile-instance'
    };
  }

  const designerMatch = normalizedRole.match(/^(.+)-designer$/);
  if (designerMatch && designerMatch[1] !== 'chief') {
    return {
      rawRole,
      normalizedRole,
      recognized: true,
      canonicalRole: 'designer',
      compatibilityAlias: 'domain-designer',
      domain: designerMatch[1],
      aliasType: 'legacy-profile-instance'
    };
  }

  const developerMatch = normalizedRole.match(/^(.+)-developer$/);
  if (developerMatch) {
    return {
      rawRole,
      normalizedRole,
      recognized: true,
      canonicalRole: 'builder',
      compatibilityAlias: 'domain-developer',
      domain: developerMatch[1],
      aliasType: 'legacy-profile-instance'
    };
  }

  return {
    rawRole,
    normalizedRole,
    recognized: false,
    canonicalRole: null,
    compatibilityAlias: null,
    domain: null
  };
}

function getRoleWritePaths(identity) {
  if (!identity || !identity.recognized) {
    return [];
  }

  if (identity.compatibilityAlias === 'part-leader' && identity.domain) {
    return [
      `src/domains/${identity.domain}/**`,
      'management/requests/to-*/**',
      `contracts/interfaces/${identity.domain}-api.yaml`,
      `management/responses/from-${identity.domain}/**`
    ];
  }

  if (identity.compatibilityAlias === 'domain-designer' && identity.domain) {
    return [
      `design/${identity.domain}/**`,
      `contracts/interfaces/${identity.domain}-components.yaml`
    ];
  }

  if (identity.compatibilityAlias === 'domain-developer' && identity.domain) {
    return [
      `src/domains/${identity.domain}/**`,
      `tests/${identity.domain}/**`
    ];
  }

  return CANONICAL_WRITE_PATHS[identity.canonicalRole] || [];
}

function globToRegex(pattern) {
  const regex = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '<<DOUBLESTAR>>')
    .replace(/\*/g, '[^/]*')
    .replace(/<<DOUBLESTAR>>/g, '.*');

  return new RegExp(`^${regex}$`);
}

function matchesAnyPattern(relativePath, patterns) {
  if (!relativePath || !Array.isArray(patterns) || patterns.length === 0) {
    return false;
  }

  return patterns.some((pattern) => !pattern.includes('!(') && globToRegex(pattern).test(relativePath));
}

function normalizeChangedFiles(changedFiles, fallbackPath) {
  if (Array.isArray(changedFiles) && changedFiles.length > 0) {
    return changedFiles
      .filter((value) => typeof value === 'string' && value.trim() !== '')
      .map((value) => value.replace(/\\/g, '/'));
  }

  if (typeof fallbackPath === 'string' && fallbackPath !== '') {
    return [fallbackPath];
  }

  return [];
}

function isLowRiskSelfCheck({ reviewOnly, selfCheck, changedFiles, relativePath }) {
  if (reviewOnly !== true && selfCheck !== true) {
    return false;
  }

  const normalizedFiles = normalizeChangedFiles(changedFiles, relativePath);
  if (normalizedFiles.length === 0 || normalizedFiles.length > 2) {
    return false;
  }

  if (normalizedFiles.some((file) => file.startsWith('src/'))) {
    return false;
  }

  return normalizedFiles.every((file) => file.startsWith('tests/') || file.startsWith('docs/'));
}

function resolveDeterministicWriteScope({ identity, allowedPaths, reviewOnly, selfCheck, changedFiles, relativePath }) {
  if (!identity || !identity.recognized) {
    return {
      recognized: false,
      source: 'unknown-role',
      writePaths: []
    };
  }

  if (Array.isArray(allowedPaths) && allowedPaths.length > 0) {
    return {
      recognized: true,
      source: 'token.allowed_paths',
      writePaths: allowedPaths
    };
  }

  if (identity.canonicalRole === 'reviewer' && isLowRiskSelfCheck({ reviewOnly, selfCheck, changedFiles, relativePath })) {
    return {
      recognized: true,
      source: 'reviewer.low-risk-self-check',
      writePaths: ['tests/**', 'docs/**']
    };
  }

  return {
    recognized: true,
    source: 'role-default',
    writePaths: getRoleWritePaths(identity)
  };
}

function checkDomainBoundary(relativePath, agentDomain) {
  if (!agentDomain) {
    return { violation: false, targetDomain: null };
  }

  const domainMatch = relativePath.match(/^src\/domains\/([^/]+)\//);
  if (domainMatch && domainMatch[1] !== agentDomain) {
    return { violation: true, targetDomain: domainMatch[1] };
  }

  const testDomainMatch = relativePath.match(/^tests\/([^/]+)\//);
  if (testDomainMatch && testDomainMatch[1] !== agentDomain) {
    return { violation: true, targetDomain: testDomainMatch[1] };
  }

  const designDomainMatch = relativePath.match(/^design\/([^/]+)\//);
  if (designDomainMatch && designDomainMatch[1] !== agentDomain) {
    return { violation: true, targetDomain: designDomainMatch[1] };
  }

  return { violation: false, targetDomain: null };
}

module.exports = {
  CANONICAL_WRITE_PATHS,
  loadTopologyRegistry,
  normalizeRole,
  resolveRoleIdentity,
  getRoleWritePaths,
  globToRegex,
  matchesAnyPattern,
  normalizeChangedFiles,
  isLowRiskSelfCheck,
  resolveDeterministicWriteScope,
  checkDomainBoundary
};
