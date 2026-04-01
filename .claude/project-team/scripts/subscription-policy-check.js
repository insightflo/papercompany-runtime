#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const SUPPORTED_EXECUTORS = ['claude', 'codex', 'gemini'];
const FORBIDDEN_ENV_KEYS = [
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY'
];

const LLM_PROVIDER_API_KEY_PATTERN = /(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)[A-Z0-9_]*API[_-]?KEY/i;

const SCAN_DIR_BLOCKLIST = new Set([
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  'coverage',
  '.tmp'
]);

const SCAN_FILE_EXTENSIONS = new Set([
  '.env',
  '.json',
  '.yaml',
  '.yml',
  '.sh'
]);

const FILE_METADATA_PATTERNS = [
  /\bOPENAI_API_KEY\b/i,
  /\bGEMINI_API_KEY\b/i,
  /\bANTHROPIC_API_KEY\b/i,
  /\bGOOGLE_API_KEY\b/i,
  /\b(?:OPENAI|ANTHROPIC|GEMINI|GOOGLE)[A-Z0-9_]*API[_-]?KEY\b/i
];

function isForbiddenEnvKey(key) {
  return FORBIDDEN_ENV_KEYS.includes(key) || LLM_PROVIDER_API_KEY_PATTERN.test(key);
}

function commandExists(command) {
  const result = spawnSync('which', [command], {
    encoding: 'utf8',
    stdio: 'pipe'
  });
  return result.status === 0;
}

function runAuthStatus(command) {
  const result = spawnSync(command, ['auth', 'status'], {
    encoding: 'utf8',
    stdio: 'pipe',
    timeout: 5000
  });
  return result.status === 0;
}

function checkClaudeState() {
  if (!commandExists('claude')) {
    return 'missing_cli';
  }
  if (!process.env.CLAUDECODE) {
    return 'host_not_attached';
  }
  return 'ok';
}

function checkExternalExecutorState(command) {
  if (!commandExists(command)) {
    return 'missing_cli';
  }
  return runAuthStatus(command) ? 'ok' : 'missing_auth';
}

function shouldScanFile(fileName) {
  if (fileName.startsWith('.env')) {
    return true;
  }
  return SCAN_FILE_EXTENSIONS.has(path.extname(fileName));
}

function walkFiles(rootDir, maxFiles) {
  const queue = [rootDir];
  const files = [];

  while (queue.length > 0 && files.length < maxFiles) {
    const dir = queue.shift();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (files.length >= maxFiles) {
        break;
      }

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SCAN_DIR_BLOCKLIST.has(entry.name)) {
          queue.push(fullPath);
        }
        continue;
      }

      if (entry.isFile() && shouldScanFile(entry.name)) {
        files.push(fullPath);
      }
    }
  }

  return files;
}

function hasMetadataApiKeyPattern(content) {
  return FILE_METADATA_PATTERNS.some((pattern) => pattern.test(content));
}

function scanForbiddenIntegrationMetadata(rootDir) {
  const selfPath = path.resolve(__filename);
  const envVarHits = Object.keys(process.env)
    .filter((key) => isForbiddenEnvKey(key))
    .sort();

  const fileHits = [];
  const files = walkFiles(rootDir, 1000);
  for (const filePath of files) {
    if (fileHits.length >= 20) {
      break;
    }
    if (path.resolve(filePath) === selfPath) {
      continue;
    }

    let content;
    try {
      content = fs.readFileSync(filePath, 'utf8');
    } catch {
      continue;
    }

    if (hasMetadataApiKeyPattern(content)) {
      fileHits.push(path.relative(rootDir, filePath));
    }
  }

  const detected = envVarHits.length > 0 || fileHits.length > 0;
  return {
    state: detected ? 'forbidden_integration' : 'none',
    detected,
    env_vars_set: envVarHits,
    env_var_hit_count: envVarHits.length,
    file_metadata_hit_count: fileHits.length,
    file_metadata_hits: fileHits
  };
}

function parseArgs() {
  const args = process.argv.slice(2);
  return {
    json: args.includes('--json')
  };
}

function buildReport() {
  const executors = {
    claude: checkClaudeState(),
    codex: checkExternalExecutorState('codex'),
    gemini: checkExternalExecutorState('gemini')
  };

  return {
    policy: {
      mode: 'subscription-only',
      allowed_executors: SUPPORTED_EXECUTORS,
      out_of_scope: ['api-key-first provider API integrations']
    },
    executors,
    forbidden_integration: scanForbiddenIntegrationMetadata(process.cwd())
  };
}

function printHuman(report) {
  console.log('Subscription Policy Check');
  console.log(`- Policy: ${report.policy.mode}`);
  console.log(`- Allowed: ${report.policy.allowed_executors.join(', ')}`);
  console.log(`- Out of scope: ${report.policy.out_of_scope[0]}`);
  console.log(`- claude: ${report.executors.claude}`);
  console.log(`- codex: ${report.executors.codex}`);
  console.log(`- gemini: ${report.executors.gemini}`);
  console.log(`- forbidden_integration: ${report.forbidden_integration.state}`);
}

function main() {
  const options = parseArgs();
  const report = buildReport();
  if (options.json) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  printHuman(report);
}

if (require.main === module) {
  main();
}

module.exports = {
  SUPPORTED_EXECUTORS,
  buildReport,
  checkClaudeState,
  checkExternalExecutorState,
  scanForbiddenIntegrationMetadata,
};
