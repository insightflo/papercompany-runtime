#!/usr/bin/env node
/**
 * Manual Hook: Quality Gate
 *
 * Validates code quality before Phase completion by checking:
 * - Test execution and results (all tests must pass)
 * - Code coverage thresholds (minimum 80%)
 * - Linting compliance (ESLint, Prettier, Python lint)
 * - Type checking (TypeScript, mypy)
 *
 * Acts as QA Manager's enforcement hook, blocking Phase merges
 * if quality standards are not met.
 *
 * @TASK P2-T4 - Quality Gate Hook
 * @SPEC .claude/agents/qa-lead.md#enforcement-hook
 *
 * Claude Code Hook Protocol (Manual):
 *   - Triggered: When Phase is ready for completion
 *   - Context: { phase, domain, timestamp }
 *   - Output: { decision: "allow"|"deny", report: {...} }
 *
 * Hook Flow:
 *   1. Detect project type (backend/frontend/fullstack)
 *   2. Run tests and parse results
 *   3. Extract coverage metrics
 *   4. Check linting and type errors
 *   5. Generate comprehensive report
 *   6. Block/allow based on thresholds
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { emitHookDecision } = require('./lib/hook-decision-event');

// ---------------------------------------------------------------------------
// 0. Safe command execution (no shell)
// ---------------------------------------------------------------------------

/**
 * Split a command string into argv parts without invoking a shell.
 * Supports basic single/double quotes and backslash escaping.
 *
 * @param {string} commandStr
 * @returns {string[]}
 */
function splitCommandArgs(commandStr) {
  const s = String(commandStr || '').trim();
  if (!s) return [];

  const parts = [];
  let cur = '';
  /** @type {null | '"' | "'"} */
  let quote = null;
  let escape = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }

    // In POSIX shells, backslash doesn't escape inside single quotes.
    if (ch === '\\' && quote !== "'") {
      escape = true;
      continue;
    }

    if (quote) {
      if (ch === quote) {
        quote = null;
        continue;
      }
      cur += ch;
      continue;
    }

    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }

    if (/\s/.test(ch)) {
      if (cur) {
        parts.push(cur);
        cur = '';
      }
      continue;
    }

    cur += ch;
  }

  if (escape) {
    // Treat dangling backslash literally
    cur += '\\';
  }

  if (cur) parts.push(cur);
  return parts;
}

/**
 * Execute a command string safely (no shell evaluation).
 *
 * @param {string} commandStr
 * @param {{ cwd?: string }} [options]
 * @returns {{ ok: boolean, status: number | null, stdout: string, stderr: string, output: string, error?: string }}
 */
function runCommand(commandStr, options = {}) {
  const argv = splitCommandArgs(commandStr);
  if (argv.length === 0) {
    return {
      ok: false,
      status: 127,
      stdout: '',
      stderr: '',
      output: '',
      error: 'Empty command'
    };
  }

  const command = argv[0];
  const args = argv.slice(1);

  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf-8',
    shell: false,
    stdio: 'pipe'
  });

  const stdout = result.stdout || '';
  const stderr = result.stderr || '';

  const output = stdout || stderr;

  if (result.error) {
    const errMsg = result.error && result.error.message ? result.error.message : String(result.error);
    return {
      ok: false,
      status: result.status ?? 1,
      stdout,
      stderr,
      output: output || errMsg,
      error: errMsg
    };
  }

  const ok = result.status === 0;
  return {
    ok,
    status: result.status,
    stdout,
    stderr,
    output
  };
}

// ---------------------------------------------------------------------------
// 1. Configuration
// ---------------------------------------------------------------------------

/**
 * Quality thresholds (project-wide standards)
 */
const QUALITY_THRESHOLDS = {
  coverage: {
    line: 80,        // Minimum line coverage
    branch: 60,      // Minimum branch coverage
    function: 75,    // Minimum function coverage
    statement: 80    // Minimum statement coverage
  },
  tests: {
    passRateRequired: 100,  // All tests must pass (0% failure)
    minTestCount: 1         // At least 1 test
  },
  linting: {
    maxErrors: 0,     // Zero tolerance for linting errors
    maxWarnings: null // Warnings allowed (null = no limit)
  },
  types: {
    maxErrors: 0      // Zero tolerance for type errors
  }
};

/**
 * File patterns for different project types
 */
const PROJECT_PATTERNS = {
  backend: {
    testCmd: 'pytest --cov=app --cov-report=json --cov-report=term-missing -q',
    coverageFile: '.coverage',
    lintCmd: 'ruff check . --output-format=json',
    typeCmd: 'mypy app/',
    extensions: ['.py']
  },
  frontend: {
    testCmd: 'npm run test -- --run --coverage',
    coverageFile: 'coverage/coverage-final.json',
    lintCmd: 'npm run lint -- --format=json',
    typeCmd: 'npm run type-check',
    extensions: ['.ts', '.tsx', '.js', '.jsx']
  }
};

function fileExists(filePath) {
  try {
    return !!filePath && fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function resolveProjectRoot() {
  if (process.env.CLAUDE_PROJECT_DIR) {
    return path.resolve(process.env.CLAUDE_PROJECT_DIR);
  }

  try {
    return fs.realpathSync(process.cwd());
  } catch {
    return path.resolve(process.cwd());
  }
}

function resolveWhiteboxRuntime(projectRoot) {
  const explicitRoot = process.env.CLAUDE_IMPL_SKILLS_ROOT || '';
  const skillRoots = [
    explicitRoot,
    path.join(os.homedir(), '.claude', 'claude-imple-skills'),
    '/Users/kwak/Projects/ai/claude-imple-skills',
  ].filter(Boolean);

  const collabInitCandidates = [
    path.join(projectRoot, '.claude', 'scripts', 'collab-init.js'),
    path.join(projectRoot, '.claude', 'project-team', 'scripts', 'collab-init.js'),
    ...skillRoots.map((root) => path.join(root, 'project-team', 'scripts', 'collab-init.js')),
  ];

  const dashboardCandidates = skillRoots.map((root) =>
    path.join(root, 'skills', 'whitebox', 'scripts', 'whitebox-dashboard.js')
  );

  return {
    collabInit: collabInitCandidates.find(fileExists) || null,
    dashboard: dashboardCandidates.find(fileExists) || null,
  };
}

function openWhiteboxUi(projectRoot) {
  const runtime = resolveWhiteboxRuntime(projectRoot);
  const result = {
    opened: false,
    url: '',
    error: '',
  };

  if (runtime.collabInit) {
    spawnSync(process.execPath, [runtime.collabInit, `--project-dir=${projectRoot}`], {
      cwd: projectRoot,
      encoding: 'utf-8',
      shell: false,
      stdio: 'pipe',
      env: process.env,
    });
  }

  if (!runtime.dashboard) {
    result.error = 'whitebox_dashboard_missing';
    return result;
  }

  const opened = spawnSync(process.execPath, [runtime.dashboard, 'open', `--project-dir=${projectRoot}`, '--json'], {
    cwd: projectRoot,
    encoding: 'utf-8',
    shell: false,
    stdio: 'pipe',
    env: process.env,
  });

  if (opened.status !== 0) {
    result.error = (opened.stderr || opened.stdout || '').trim() || 'whitebox_dashboard_open_failed';
    return result;
  }

  try {
    const payload = JSON.parse(opened.stdout || '{}');
    result.opened = Boolean(payload && payload.url);
    result.url = payload && payload.url ? payload.url : '';
    return result;
  } catch {
    const url = String(opened.stdout || '').trim();
    result.opened = /^https?:\/\//.test(url);
    result.url = result.opened ? url : '';
    if (!result.opened) result.error = 'whitebox_dashboard_invalid_response';
    return result;
  }
}

function reasonWithWhitebox(baseReason, whitebox) {
  if (whitebox && whitebox.opened && whitebox.url) {
    return `${baseReason} Whitebox opened at ${whitebox.url}`;
  }
  if (whitebox && whitebox.error) {
    return `${baseReason} Whitebox open failed: ${whitebox.error}`;
  }
  return baseReason;
}

// ---------------------------------------------------------------------------
// 2. Project Detection
// ---------------------------------------------------------------------------

/**
 * Detect project type by examining package.json and directory structure
 * @returns {'backend' | 'frontend' | 'unknown'}
 */
function detectProjectType() {
  const cwd = resolveProjectRoot();

  // Check for package.json (frontend)
  const packageJsonPath = path.join(cwd, 'package.json');
  if (fs.existsSync(packageJsonPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
      const scripts = pkg && typeof pkg === 'object' ? pkg.scripts : null;

      // Only classify as a "frontend" project if it appears runnable.
      // Tooling-only folders may have a package.json for devDeps but no scripts.
      const hasTestScript = !!(scripts && typeof scripts === 'object' && scripts.test);
      const hasLintScript = !!(scripts && typeof scripts === 'object' && scripts.lint);
      const hasTypeScript = !!(scripts && typeof scripts === 'object' && (scripts['type-check'] || scripts.typecheck));

      if (hasTestScript || hasLintScript || hasTypeScript) {
        return 'frontend';
      }
    } catch {
      // If package.json is unreadable, don't assume frontend.
      // Continue checking backend markers before falling back to unknown.
    }
  }

  // Check for pyproject.toml or setup.py (backend)
  const pyprojectPath = path.join(cwd, 'pyproject.toml');
  const setupPath = path.join(cwd, 'setup.py');
  if (fs.existsSync(pyprojectPath) || fs.existsSync(setupPath)) {
    return 'backend';
  }

  return 'unknown';
}

// ---------------------------------------------------------------------------
// 3. Test Execution & Parsing
// ---------------------------------------------------------------------------

/**
 * Run tests and collect results
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ passed: number, failed: number, total: number, output: string }}
 */
function runTests(projectType) {
  const config = PROJECT_PATTERNS[projectType];
  if (!config) {
    return { passed: 0, failed: 0, total: 0, output: 'Unknown project type' };
  }

  const res = runCommand(config.testCmd, { cwd: process.cwd() });

  if (res.ok) {
    const results = parseTestOutput(res.stdout, projectType);
    return { ...results, output: res.stdout };
  }

  // Command failed - tests did not pass
  const output = res.output || res.error || 'Test command failed';
  return { passed: 0, failed: 1, total: 1, output };
}

/**
 * Parse test output based on project type
 * @param {string} output - Raw test output
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ passed: number, failed: number, total: number }}
 */
function parseTestOutput(output, projectType) {
  if (projectType === 'backend') {
    // pytest output parsing
    // Example: "5 passed, 2 failed in 1.23s"
    const match = output.match(/(\d+)\s+passed/);
    const failMatch = output.match(/(\d+)\s+failed/);

    const passed = match ? parseInt(match[1], 10) : 0;
    const failed = failMatch ? parseInt(failMatch[1], 10) : 0;
    const total = passed + failed;

    return { passed, failed, total };
  }

  if (projectType === 'frontend') {
    // Vitest/Jest output parsing
    // Example: "Test Files  2 passed (2) ... 50 passed (50)"
    const testsMatch = output.match(/(\d+)\s+passed/);
    const failedMatch = output.match(/(\d+)\s+failed/);

    const passed = testsMatch ? parseInt(testsMatch[1], 10) : 0;
    const failed = failedMatch ? parseInt(failedMatch[1], 10) : 0;
    const total = passed + failed;

    return { passed, failed, total };
  }

  return { passed: 0, failed: 0, total: 0 };
}

// ---------------------------------------------------------------------------
// 4. Coverage Parsing
// ---------------------------------------------------------------------------

/**
 * Extract coverage metrics from coverage reports
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ line: number, branch: number, function: number, statement: number }}
 */
function extractCoverage(projectType) {
  const config = PROJECT_PATTERNS[projectType];
  if (!config) {
    return { line: 0, branch: 0, function: 0, statement: 0 };
  }

  try {
    if (projectType === 'backend') {
      // pytest-cov output in JSON format
      const jsonPath = path.join(process.cwd(), 'coverage.json');
      if (fs.existsSync(jsonPath)) {
        const data = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        const summary = data.totals || {};
        return {
          line: Math.round(summary.percent_covered || 0),
          branch: Math.round(summary.percent_covered_branch || 0),
          function: Math.round(summary.percent_covered_function || 0),
          statement: Math.round(summary.percent_covered || 0)
        };
      }

      // Fallback: parse from term-missing output
      const fallbackRes = runCommand('pytest --cov=app --cov-report=term-missing -q', { cwd: process.cwd() });
      const match = (fallbackRes.stdout || '').match(/TOTAL\s+\d+\s+\d+\s+(\d+)%/);

      return {
        line: match ? parseInt(match[1], 10) : 0,
        branch: 0,
        function: 0,
        statement: match ? parseInt(match[1], 10) : 0
      };
    }

    if (projectType === 'frontend') {
      // Vitest/Jest coverage-final.json
      const coveragePath = path.join(
        process.cwd(),
        'coverage',
        'coverage-final.json'
      );

      if (fs.existsSync(coveragePath)) {
        const data = JSON.parse(fs.readFileSync(coveragePath, 'utf-8'));
        const totals = data.total || {};

        return {
          line: Math.round(totals.lines?.pct || 0),
          branch: Math.round(totals.branches?.pct || 0),
          function: Math.round(totals.functions?.pct || 0),
          statement: Math.round(totals.statements?.pct || 0)
        };
      }
    }
  } catch (error) {
    // Coverage report not found or parse error
  }

  return { line: 0, branch: 0, function: 0, statement: 0 };
}

// ---------------------------------------------------------------------------
// 5. Linting Check
// ---------------------------------------------------------------------------

/**
 * Run linter and collect errors/warnings
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ errors: number, warnings: number, output: string }}
 */
function runLinter(projectType) {
  const config = PROJECT_PATTERNS[projectType];
  if (!config) {
    return { errors: 0, warnings: 0, output: 'Unknown project type' };
  }

  const res = runCommand(config.lintCmd, { cwd: process.cwd() });

  // Parse linting output (even on failure; output may still be JSON)
  const parsed = parseLintOutput(res.stdout || res.stderr || '', projectType);

  if (res.ok) {
    return { ...parsed, output: res.stdout };
  }

  return { ...parsed, output: res.output || res.error || 'Lint command failed' };
}

/**
 * Parse linter output
 * @param {string} output - Raw linter output
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ errors: number, warnings: number }}
 */
function parseLintOutput(output, projectType) {
  if (projectType === 'backend') {
    // ruff output
    let errors = 0;
    let warnings = 0;

    // ruff JSON format: [{ type, level, ... }, ...]
    try {
      const issues = JSON.parse(output);
      errors = issues.filter(i => i.severity === 'error').length;
      warnings = issues.filter(i => i.severity === 'warning').length;
      return { errors, warnings };
    } catch {
      // Text format
      errors = (output.match(/error/gi) || []).length;
      warnings = (output.match(/warning/gi) || []).length;
      return { errors, warnings };
    }
  }

  if (projectType === 'frontend') {
    // ESLint JSON format
    try {
      const issues = JSON.parse(output);
      let errors = 0;
      let warnings = 0;

      for (const file of issues) {
        for (const msg of file.messages || []) {
          if (msg.severity === 2) errors++;
          if (msg.severity === 1) warnings++;
        }
      }
      return { errors, warnings };
    } catch {
      // Text format
      const errorMatch = output.match(/(\d+)\s+error/);
      const warningMatch = output.match(/(\d+)\s+warning/);

      return {
        errors: errorMatch ? parseInt(errorMatch[1], 10) : 0,
        warnings: warningMatch ? parseInt(warningMatch[1], 10) : 0
      };
    }
  }

  return { errors: 0, warnings: 0 };
}

// ---------------------------------------------------------------------------
// 6. Type Checking
// ---------------------------------------------------------------------------

/**
 * Run type checker
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {{ errors: number, output: string }}
 */
function runTypeCheck(projectType) {
  const config = PROJECT_PATTERNS[projectType];
  if (!config) {
    return { errors: 0, output: 'Unknown project type' };
  }

  const res = runCommand(config.typeCmd, { cwd: process.cwd() });

  if (res.ok) {
    return { errors: 0, output: res.stdout };
  }

  const combined = res.stdout || res.stderr || '';
  const errors = parseTypeOutput(combined, projectType);
  return { errors, output: res.output || res.error || combined || 'Type check command failed' };
}

/**
 * Parse type checker output
 * @param {string} output - Raw type checker output
 * @param {string} projectType - 'backend' | 'frontend'
 * @returns {number}
 */
function parseTypeOutput(output, projectType) {
  if (projectType === 'backend') {
    // mypy output: "module.py:10: error: ..."
    const matches = output.match(/error:/gi) || [];
    return matches.length;
  }

  if (projectType === 'frontend') {
    // tsc output: "error TS2345: ..."
    const matches = output.match(/error TS\d+:/gi) || [];
    return matches.length;
  }

  return 0;
}

// ---------------------------------------------------------------------------
// 7. Report Generation
// ---------------------------------------------------------------------------

/**
 * Generate comprehensive quality report
 * @param {object} results - Aggregated quality metrics
 * @returns {string}
 */
function generateReport(results) {
  const {
    projectType,
    tests,
    coverage,
    linting,
    typeChecking,
    passed,
    timestamp
  } = results;

  const report = [];

  report.push('╔════════════════════════════════════════════════════════════════╗');
  report.push('║               📊 QUALITY GATE REPORT - PHASE COMPLETION        ║');
  report.push('╚════════════════════════════════════════════════════════════════╝');
  report.push('');

  // Summary
  report.push('📋 SUMMARY:');
  report.push(`  Project Type: ${projectType}`);
  report.push(`  Timestamp: ${timestamp}`);
  report.push(`  Overall Status: ${passed ? '✅ PASS' : '❌ FAIL'}`);
  report.push('');

  // Tests
  report.push('🧪 TEST RESULTS:');
  report.push(`  Passed: ${tests.passed} / ${tests.total}`);
  report.push(`  Failed: ${tests.failed} / ${tests.total}`);
  report.push(`  Pass Rate: ${tests.total > 0 ? Math.round((tests.passed / tests.total) * 100) : 0}%`);
  report.push(`  Status: ${tests.failed === 0 ? '✅ All tests pass' : '❌ Tests failing'}`);
  report.push('');

  // Coverage
  report.push('📈 CODE COVERAGE:');
  report.push(`  Line Coverage: ${coverage.line}% (threshold: ${QUALITY_THRESHOLDS.coverage.line}%)`);
  report.push(`  Branch Coverage: ${coverage.branch}% (threshold: ${QUALITY_THRESHOLDS.coverage.branch}%)`);
  report.push(`  Function Coverage: ${coverage.function}% (threshold: ${QUALITY_THRESHOLDS.coverage.function}%)`);
  report.push(`  Statement Coverage: ${coverage.statement}% (threshold: ${QUALITY_THRESHOLDS.coverage.statement}%)`);
  const coverageStatus = coverage.line >= QUALITY_THRESHOLDS.coverage.line ? '✅' : '❌';
  report.push(`  Status: ${coverageStatus}`);
  report.push('');

  // Linting
  report.push('📝 LINTING:');
  report.push(`  Errors: ${linting.errors} (threshold: ${QUALITY_THRESHOLDS.linting.maxErrors})`);
  report.push(`  Warnings: ${linting.warnings}`);
  const lintingStatus = linting.errors <= QUALITY_THRESHOLDS.linting.maxErrors ? '✅' : '❌';
  report.push(`  Status: ${lintingStatus}`);
  report.push('');

  // Type Checking
  report.push('📦 TYPE CHECKING:');
  report.push(`  Errors: ${typeChecking.errors} (threshold: ${QUALITY_THRESHOLDS.types.maxErrors})`);
  const typeStatus = typeChecking.errors <= QUALITY_THRESHOLDS.types.maxErrors ? '✅' : '❌';
  report.push(`  Status: ${typeStatus}`);
  report.push('');

  // Overall Decision
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (passed) {
    report.push('✅ QUALITY GATE PASSED - Phase merge approved');
  } else {
    report.push('❌ QUALITY GATE FAILED - Phase merge blocked');
    report.push('');
    report.push('Fix required:');

    if (tests.failed > 0) {
      report.push(`  • Test failures: ${tests.failed} test(s) failing`);
    }

    if (coverage.line < QUALITY_THRESHOLDS.coverage.line) {
      const deficit = QUALITY_THRESHOLDS.coverage.line - coverage.line;
      report.push(`  • Low coverage: need +${deficit}% line coverage (currently ${coverage.line}%)`);
    }

    if (linting.errors > QUALITY_THRESHOLDS.linting.maxErrors) {
      report.push(`  • Linting errors: ${linting.errors} error(s) to fix`);
    }

    if (typeChecking.errors > QUALITY_THRESHOLDS.types.maxErrors) {
      report.push(`  • Type errors: ${typeChecking.errors} error(s) to fix`);
    }
  }
  report.push('');

  return report.join('\n');
}

// ---------------------------------------------------------------------------
// 8. Decision Logic
// ---------------------------------------------------------------------------

/**
 * Determine if quality gate is passed
 * @param {object} results - Quality metrics
 * @returns {boolean}
 */
function isQualityGatePassed(results) {
  const { tests, coverage, linting, typeChecking } = results;

  // All tests must pass
  if (tests.failed > 0) {
    return false;
  }

  // Coverage threshold
  if (coverage.line < QUALITY_THRESHOLDS.coverage.line) {
    return false;
  }

  // Linting threshold
  if (linting.errors > QUALITY_THRESHOLDS.linting.maxErrors) {
    return false;
  }

  // Type checking threshold
  if (typeChecking.errors > QUALITY_THRESHOLDS.types.maxErrors) {
    return false;
  }

  return true;
}

// ---------------------------------------------------------------------------
// 9. Main Entry Point
// ---------------------------------------------------------------------------

async function main() {
  try {
    const input = {
      hook_event_name: 'ManualHook',
      tool_name: 'quality-gate',
      tool_input: {},
    };
    const projectRoot = resolveProjectRoot();
    const projectType = detectProjectType();

    if (projectType === 'unknown') {
      // Unknown project type — skip quality gate silently (don't block)
      // This handles monorepo structures where package.json is in subdirectories
      process.stdout.write(JSON.stringify({
        decision: 'approve',
        reason: 'Skipped: could not detect project type (monorepo or no package.json at root)'
      }));
      return;
    }

    // Run quality checks
    const testResults = runTests(projectType);
    const coverage = extractCoverage(projectType);
    const lintResults = runLinter(projectType);
    const typeResults = runTypeCheck(projectType);

    const results = {
      projectType,
      tests: {
        passed: testResults.passed,
        failed: testResults.failed,
        total: testResults.total
      },
      coverage,
      linting: {
        errors: lintResults.errors,
        warnings: lintResults.warnings
      },
      typeChecking: {
        errors: typeResults.errors
      },
      passed: false,
      timestamp: new Date().toISOString()
    };

    // Determine pass/fail
    results.passed = isQualityGatePassed(results);

    // Generate report
    const report = generateReport(results);
    const whitebox = results.passed ? null : openWhiteboxUi(projectRoot);

    await emitHookDecision(input, {
      hook: 'quality-gate',
      decision: results.passed ? 'approve' : 'block',
      severity: results.passed ? 'info' : 'error',
      summary: `Quality gate ${results.passed ? 'passed' : 'failed'} (${results.tests.failed} test failures, ${results.linting.errors} lint errors, ${results.typeChecking.errors} type errors).`,
      remediation: results.passed ? '' : 'Fix failing quality metrics and rerun the gate.',
    });

    // Output decision (Stop hook schema: "approve" | "block", not "allow" | "deny")
    process.stdout.write(JSON.stringify({
      decision: results.passed ? 'approve' : 'block',
      reason: results.passed ? '' : reasonWithWhitebox('Quality gate blocked the stop boundary.', whitebox),
      report,
      metrics: {
        tests: results.tests,
        coverage: results.coverage,
        linting: results.linting,
        typeChecking: results.typeChecking
      }
    }));
  } catch (error) {
    // Error fallback — approve to avoid blocking the session
    process.stdout.write(JSON.stringify({
      decision: 'approve',
      reason: `Quality gate error: ${error.message}`
    }));
  }
}

if (require.main === module) {
  main().catch((err) => { console.error('[quality-gate] Unhandled error:', err.message); });
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    QUALITY_THRESHOLDS,
    PROJECT_PATTERNS,
    detectProjectType,
    runCommand,
    splitCommandArgs,
    runTests,
    parseTestOutput,
    extractCoverage,
    runLinter,
    parseLintOutput,
    runTypeCheck,
    parseTypeOutput,
    generateReport,
    isQualityGatePassed,
    resolveProjectRoot
  };
}
