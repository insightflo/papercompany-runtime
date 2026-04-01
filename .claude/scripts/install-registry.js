#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const SCRIPT_DIR = __dirname;
const PROJECT_TEAM_DIR = path.resolve(SCRIPT_DIR, '..');
const REGISTRY_PATH = path.join(PROJECT_TEAM_DIR, 'config', 'topology-registry.json');
const EXPECTED_CANONICAL_ROLES = [
  'lead',
  'builder',
  'reviewer',
  'designer',
  'dba',
  'security-specialist'
];
const EXPECTED_MODE_ROLE_MAP = {
  lite: ['lead', 'builder', 'reviewer'],
  standard: ['lead', 'builder', 'reviewer', 'designer', 'dba', 'security-specialist'],
  full: ['lead', 'builder', 'reviewer', 'designer', 'dba', 'security-specialist']
};
const EXPECTED_MODE_HOOK_MAP = {
  lite: ['permission-checker', 'policy-gate', 'security-scan'],
  standard: [
    'permission-checker',
    'policy-gate',
    'security-scan',
    'quality-gate',
    'contract-gate',
    'pre-edit-impact-check'
  ],
  full: [
    'permission-checker',
    'policy-gate',
    'security-scan',
    'quality-gate',
    'contract-gate',
    'pre-edit-impact-check',
    'docs-gate',
    'risk-gate',
    'domain-boundary-enforcer',
    'architecture-updater',
    'changelog-recorder',
    'cross-domain-notifier',
    'interface-validator',
    'standards-validator',
    'design-validator',
    'task-sync'
  ]
};
const EXPECTED_FULL_COMPATIBILITY_PROFILES = [
  'part-leader',
  'domain-designer',
  'domain-developer'
];

function stableArray(values) {
  return [...new Set(values)].sort();
}

function readRegistry() {
  return JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
}

function usage() {
  process.stderr.write(
    [
      'Usage:',
      '  node project-team/scripts/install-registry.js validate',
      '  node project-team/scripts/install-registry.js mode <lite|standard|full>',
      '  node project-team/scripts/install-registry.js owned <lite|standard|full>'
    ].join('\n') + '\n'
  );
}

function arraysEqual(left, right) {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((value, index) => value === right[index]);
}

function getModeConfig(registry, modeName) {
  const mode = registry.modes[modeName];
  if (!mode) {
    throw new Error(`Unknown mode: ${modeName}`);
  }
  return mode;
}

function getCompatibilityMetadata(registry, modeName) {
  const profileAliases = registry.legacyAliases.profiles.map((profile) => ({
    alias: profile.alias,
    artifact: profile.artifact,
    canonicalRole: profile.canonicalRole,
    installedInMode: modeName === 'full'
  }));

  return {
    ...registry.compatibility,
    agentAliases: registry.legacyAliases.agents,
    profileAliases
  };
}

function getActiveHelperHooks(registry) {
  return Object.entries(registry.hooks.definitions)
    .filter(([, definition]) => definition.installType === 'helper')
    .map(([name, definition]) => {
      const matcherList = definition.matcherListKey
        ? registry.hooks.matcherLists[definition.matcherListKey] || []
        : [];
      return {
        name,
        artifact: definition.artifact,
        event: definition.event,
        matcher: definition.matcher || null,
        matcherListKey: definition.matcherListKey || null,
        matcherList,
        active: matcherList.length > 0
      };
    })
    .filter((helper) => helper.active)
    .sort((left, right) => left.name.localeCompare(right.name));
}

function getModeArtifacts(registry, modeName) {
  const mode = getModeConfig(registry, modeName);
  const canonicalAgentArtifacts = mode.canonicalRoles.flatMap((roleName) => registry.roles[roleName].artifacts);
  const compatibilityAgentArtifacts = registry.legacyAliases.agents.map((entry) => entry.artifact);
  const compatibilityProfileArtifacts = mode.compatibilityProfiles.map((profileAlias) => {
    const profile = registry.legacyAliases.profiles.find((entry) => entry.alias === profileAlias);
    if (!profile) {
      throw new Error(`Unknown compatibility profile alias: ${profileAlias}`);
    }
    return profile.artifact;
  });
  const activeHookArtifacts = mode.hookNames.map((hookName) => registry.hooks.definitions[hookName].artifact);
  const activeHelperArtifacts = getActiveHelperHooks(registry).map((helper) => helper.artifact);

  const grouped = {
    agents: stableArray([...canonicalAgentArtifacts, ...compatibilityAgentArtifacts, ...compatibilityProfileArtifacts]),
    hooks: stableArray([...activeHookArtifacts, ...activeHelperArtifacts]),
    templates: stableArray(registry.installerOwnership.commonArtifacts),
    settings: stableArray(registry.installerOwnership.managedSettingsArtifacts)
  };

  return {
    grouped,
    flattened: stableArray([
      ...grouped.agents,
      ...grouped.hooks,
      ...grouped.templates,
      ...grouped.settings
    ])
  };
}

function buildModePayload(registry, modeName) {
  const mode = getModeConfig(registry, modeName);
  const artifacts = getModeArtifacts(registry, modeName);

  return {
    registryVersion: registry.registryVersion,
    mode: modeName,
    description: mode.description,
    canonicalRoleCount: mode.canonicalRoles.length,
    canonicalRoles: mode.canonicalRoles.map((roleName) => ({
      id: roleName,
      ...registry.roles[roleName]
    })),
    specialistRoles: mode.canonicalRoles.filter((roleName) => registry.roles[roleName].kind === 'specialist'),
    hooks: {
      active: mode.hookNames.map((hookName) => ({
        name: hookName,
        ...registry.hooks.definitions[hookName]
      })),
      helpers: getActiveHelperHooks(registry)
    },
    compatibility: getCompatibilityMetadata(registry, modeName),
    compatibilityProfiles: mode.compatibilityProfiles,
    artifacts: artifacts.grouped
  };
}

function validateRegistry(registry) {
  const issues = [];

  if (!arraysEqual(registry.canonicalRoleOrder, EXPECTED_CANONICAL_ROLES)) {
    issues.push('canonicalRoleOrder must match the fixed canonical role sequence');
  }

  const modeNames = Object.keys(registry.modes).sort();
  if (!arraysEqual(modeNames, ['full', 'lite', 'standard'])) {
    issues.push('modes must be exactly lite, standard, and full');
  }

  for (const roleName of EXPECTED_CANONICAL_ROLES) {
    if (!registry.roles[roleName]) {
      issues.push(`missing canonical role definition: ${roleName}`);
    }
  }

  for (const [modeName, expectedRoles] of Object.entries(EXPECTED_MODE_ROLE_MAP)) {
    const mode = registry.modes[modeName];
    if (!mode) {
      continue;
    }
    if (!arraysEqual(mode.canonicalRoles, expectedRoles)) {
      issues.push(`${modeName} canonicalRoles diverged from the plan`);
    }
    if (!arraysEqual(mode.hookNames, EXPECTED_MODE_HOOK_MAP[modeName])) {
      issues.push(`${modeName} hookNames diverged from the plan`);
    }
  }

  if (!arraysEqual(registry.modes.full.compatibilityProfiles, EXPECTED_FULL_COMPATIBILITY_PROFILES)) {
    issues.push('full compatibilityProfiles must match the fixed compatibility profile set');
  }

  if ((registry.modes.lite.compatibilityProfiles || []).length !== 0) {
    issues.push('lite must not install compatibility profiles');
  }

  if ((registry.modes.standard.compatibilityProfiles || []).length !== 0) {
    issues.push('standard must not install compatibility profiles');
  }

  if (registry.compatibility.installAliasesInEveryMode !== true) {
    issues.push('compatibility aliases must install in every mode');
  }

  if (registry.compatibility.countAliasesInCanonicalTotals !== false) {
    issues.push('compatibility aliases must not count toward canonical role totals');
  }

  if (registry.compatibility.fullModeRestoresLegacyRuntime !== false) {
    issues.push('full mode must not restore the legacy runtime');
  }

  for (const alias of registry.legacyAliases.agents) {
    if (!registry.roles[alias.canonicalRole]) {
      issues.push(`legacy agent alias ${alias.alias} targets unknown role ${alias.canonicalRole}`);
    }
  }

  for (const profile of registry.legacyAliases.profiles) {
    if (!registry.roles[profile.canonicalRole]) {
      issues.push(`legacy profile alias ${profile.alias} targets unknown role ${profile.canonicalRole}`);
    }
  }

  for (const hookName of stableArray([
    ...Object.values(registry.modes).flatMap((mode) => mode.hookNames),
    ...Object.keys(registry.hooks.definitions)
  ])) {
    if (!registry.hooks.definitions[hookName]) {
      issues.push(`missing hook definition: ${hookName}`);
    }
  }

  const riskHelper = registry.hooks.definitions['risk-area-warning'];
  if (!riskHelper || riskHelper.installType !== 'helper') {
    issues.push('risk-area-warning must be registered as a helper hook');
  }

  const matcherList = riskHelper && riskHelper.matcherListKey
    ? registry.hooks.matcherLists[riskHelper.matcherListKey] || []
    : [];
  if (matcherList.length === 0) {
    issues.push('risk-area-warning requires a non-empty matcher list in the registry');
  }

  for (const modeName of Object.keys(registry.modes)) {
    try {
      const artifacts = getModeArtifacts(registry, modeName);
      if (artifacts.flattened.length === 0) {
        issues.push(`${modeName} produced an empty artifact inventory`);
      }
    } catch (error) {
      issues.push(`${modeName} artifact generation failed: ${error.message}`);
    }
  }

  return {
    ok: issues.length === 0,
    issues,
    modeSummaries: Object.keys(registry.modes)
      .sort()
      .map((modeName) => ({
        mode: modeName,
        canonicalRoles: registry.modes[modeName].canonicalRoles,
        hookNames: registry.modes[modeName].hookNames,
        compatibilityProfiles: registry.modes[modeName].compatibilityProfiles,
        ownedArtifactCount: getModeArtifacts(registry, modeName).flattened.length
      }))
  };
}

function printJson(value, exitCode) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
  process.exit(exitCode);
}

function main(argv) {
  const command = argv[2];
  const argument = argv[3];

  if (!command) {
    usage();
    process.exit(2);
  }

  const registry = readRegistry();

  try {
    switch (command) {
      case 'validate': {
        const result = validateRegistry(registry);
        printJson(result, result.ok ? 0 : 1);
        break;
      }
      case 'mode': {
        if (!argument) {
          throw new Error('Missing mode name');
        }
        printJson(buildModePayload(registry, argument), 0);
        break;
      }
      case 'owned': {
        if (!argument) {
          throw new Error('Missing mode name');
        }
        const artifacts = getModeArtifacts(registry, argument);
        printJson(
          {
            registryVersion: registry.registryVersion,
            mode: argument,
            grouped: artifacts.grouped,
            artifacts: artifacts.flattened
          },
          0
        );
        break;
      }
      default:
        usage();
        process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(1);
  }
}

if (require.main === module) {
  main(process.argv);
}

module.exports = {
  buildModePayload,
  getModeArtifacts,
  getActiveHelperHooks,
  readRegistry,
  validateRegistry
};
