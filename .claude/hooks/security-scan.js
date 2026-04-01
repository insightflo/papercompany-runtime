#!/usr/bin/env node
/**
 * Manual Hook: Security Scan
 *
 * Performs security scanning including:
 * - OWASP Top 10 pattern detection
 * - Secret/credential detection
 * - Dependency CVE scanning
 * - Permission boundary verification
 *
 * Acts as Security Specialist's enforcement hook.
 *
 * @TASK P1-SECURITY - Security Scan Hook
 * @SPEC .claude/agents/qa-lead.md#enforcement-hook
 *
 * Claude Code Hook Protocol (Manual):
 *   - Triggered: After Edit/Write, before Phase completion
 *   - Context: { files, phase, domain, timestamp }
 *   - Output: { decision: "approve"|"block", report: {...}, findings: [...] }
 */

const { spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { emitHookDecision } = require('./lib/hook-decision-event');

// ---------------------------------------------------------------------------
// 1. Secret Detection Patterns
// ---------------------------------------------------------------------------

const SECRET_PATTERNS = [
  {
    name: 'AWS Access Key',
    regex: /AKIA[0-9A-Z]{16}/g,
    severity: 'CRITICAL'
  },
  {
    name: 'AWS Secret Key',
    regex: /(?<![A-Za-z0-9/+=])[A-Za-z0-9/+=]{40}(?![A-Za-z0-9/+=])/g,
    severity: 'CRITICAL',
    contextRequired: true // Needs AWS context
  },
  {
    name: 'Private Key',
    regex: /-----BEGIN (RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g,
    severity: 'CRITICAL'
  },
  {
    name: 'API Key Generic',
    regex: /(api[_-]?key|apikey)\s*[:=]\s*['"][a-zA-Z0-9]{20,}['"]/gi,
    severity: 'HIGH'
  },
  {
    name: 'Database URL with Password',
    regex: /(postgres|mysql|mongodb|redis):\/\/[^:]+:[^@]+@[^/]+/gi,
    severity: 'HIGH'
  },
  {
    name: 'JWT Token',
    regex: /eyJ[A-Za-z0-9-_=]+\.eyJ[A-Za-z0-9-_=]+\.[A-Za-z0-9-_.+/=]*/g,
    severity: 'HIGH'
  },
  {
    name: 'GitHub Token',
    regex: /(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9_]{36,}/g,
    severity: 'CRITICAL'
  },
  {
    name: 'Slack Token',
    regex: /xox[baprs]-[0-9]+-[0-9]+-[a-zA-Z0-9]+/g,
    severity: 'HIGH'
  },
  {
    name: 'Password in Config',
    regex: /password\s*[:=]\s*['"][^'"]{8,}['"]/gi,
    severity: 'MEDIUM'
  },
  {
    name: 'Bearer Token',
    regex: /Bearer\s+[a-zA-Z0-9\-_.~+/]+=*/g,
    severity: 'MEDIUM'
  }
];

// ---------------------------------------------------------------------------
// 2. OWASP Top 10 Patterns
// ---------------------------------------------------------------------------

const OWASP_PATTERNS = [
  // A03: Injection
  {
    name: 'SQL Injection',
    category: 'A03:Injection',
    regex: /(?:execute|query|cursor\.execute)\s*\(\s*(?:f['"']|['"].*%s|['"].*\+\s*)/gi,
    severity: 'CRITICAL',
    description: 'Potential SQL injection via string concatenation or f-string'
  },
  {
    name: 'Command Injection',
    category: 'A03:Injection',
    regex: /(?:subprocess|os\.system|os\.popen|eval|exec)\s*\([^)]*(?:\+|%|f['"])/gi,
    severity: 'CRITICAL',
    description: 'Potential command injection via dynamic input'
  },
  // A02: Cryptographic Failures
  {
    name: 'Weak Hash Algorithm',
    category: 'A02:Cryptographic Failures',
    regex: /(?:md5|sha1)\s*\(/gi,
    severity: 'MEDIUM',
    description: 'Weak hash algorithm (use SHA-256 or better)'
  },
  {
    name: 'Hardcoded Secret',
    category: 'A02:Cryptographic Failures',
    regex: /(?:secret|password|api_key|apikey|auth_token)\s*=\s*['"][^'"]{8,}['"]/gi,
    severity: 'HIGH',
    description: 'Hardcoded secret in source code'
  },
  // A05: Security Misconfiguration
  {
    name: 'Debug Mode Enabled',
    category: 'A05:Security Misconfiguration',
    regex: /(?:DEBUG|debug)\s*[:=]\s*(?:true|True|1)/g,
    severity: 'MEDIUM',
    description: 'Debug mode should be disabled in production'
  },
  {
    name: 'CORS Allow All',
    category: 'A05:Security Misconfiguration',
    regex: /(?:Access-Control-Allow-Origin|cors).*\*/gi,
    severity: 'MEDIUM',
    description: 'CORS allows all origins'
  },
  // A07: Authentication Failures
  {
    name: 'No Password Hashing',
    category: 'A07:Authentication Failures',
    regex: /password\s*==\s*(?:request|input|data)\./gi,
    severity: 'HIGH',
    description: 'Direct password comparison without hashing'
  },
  // A10: SSRF
  {
    name: 'Potential SSRF',
    category: 'A10:SSRF',
    regex: /(?:requests\.get|fetch|axios\.get|http\.get)\s*\(\s*(?:request|input|data)\./gi,
    severity: 'HIGH',
    description: 'Potential SSRF via user-controlled URL'
  }
];

// ---------------------------------------------------------------------------
// 3. File Scanning
// ---------------------------------------------------------------------------

/**
 * Scan a single file for security issues
 * @param {string} filePath - Path to file
 * @returns {{ secrets: Array, owasp: Array }}
 */
function scanFile(filePath) {
  const findings = {
    secrets: [],
    owasp: []
  };

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');

    // Scan for secrets
    for (const pattern of SECRET_PATTERNS) {
      let match;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = content.substring(0, match.index).split('\n').length;
        findings.secrets.push({
          type: pattern.name,
          severity: pattern.severity,
          file: filePath,
          line: lineNumber,
          match: maskSecret(match[0])
        });
      }
    }

    // Scan for OWASP patterns
    for (const pattern of OWASP_PATTERNS) {
      let match;
      const regex = new RegExp(pattern.regex.source, pattern.regex.flags);

      while ((match = regex.exec(content)) !== null) {
        const lineNumber = content.substring(0, match.index).split('\n').length;
        findings.owasp.push({
          type: pattern.name,
          category: pattern.category,
          severity: pattern.severity,
          description: pattern.description,
          file: filePath,
          line: lineNumber,
          snippet: lines[lineNumber - 1]?.trim().substring(0, 100)
        });
      }
    }
  } catch (error) {
    // File read error - skip
  }

  return findings;
}

/**
 * Mask sensitive data in findings
 * @param {string} secret - Secret to mask
 * @returns {string}
 */
function maskSecret(secret) {
  if (secret.length <= 8) {
    return '***';
  }
  return secret.substring(0, 4) + '***' + secret.substring(secret.length - 4);
}

// ---------------------------------------------------------------------------
// 4. Dependency CVE Scanning
// ---------------------------------------------------------------------------

/**
 * CLI 명령어 존재 여부 확인 (Agent Teams 환경에서 외부 도구 미설치 대비)
 * @param {string} command
 * @returns {boolean}
 */
function isCommandAvailable(command) {
  try {
    const result = spawnSync('which', [command], {
      encoding: 'utf-8',
      shell: false,
      stdio: 'pipe',
      timeout: 3000
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

/**
 * Run dependency vulnerability scan
 * 외부 도구(npm, pip-audit)가 없으면 해당 스캔을 건너뜀 (graceful degradation)
 * @returns {{ vulnerabilities: Array, summary: object }}
 */
function scanDependencies() {
  const result = {
    vulnerabilities: [],
    summary: { critical: 0, high: 0, medium: 0, low: 0 }
  };

  // Check npm audit (npm 존재 확인 후 실행)
  if (fs.existsSync('package.json') && isCommandAvailable('npm')) {
    try {
      const npmResult = spawnSync('npm', ['audit', '--json'], {
        encoding: 'utf-8',
        shell: false,
        stdio: 'pipe',
        timeout: 30000
      });

      if (npmResult.stdout) {
        const auditData = JSON.parse(npmResult.stdout);
        if (auditData.vulnerabilities) {
          for (const [pkg, data] of Object.entries(auditData.vulnerabilities)) {
            result.vulnerabilities.push({
              package: pkg,
              severity: data.severity,
              via: data.via,
              fixAvailable: data.fixAvailable
            });
            result.summary[data.severity] = (result.summary[data.severity] || 0) + 1;
          }
        }
      }
    } catch {
      // npm audit failed - continue
    }
  }

  // Check pip-audit (pip-audit 존재 확인 후 실행)
  if ((fs.existsSync('requirements.txt') || fs.existsSync('pyproject.toml')) && isCommandAvailable('pip-audit')) {
    try {
      const pipResult = spawnSync('pip-audit', ['--format=json'], {
        encoding: 'utf-8',
        shell: false,
        stdio: 'pipe',
        timeout: 30000
      });

      if (pipResult.stdout) {
        const auditData = JSON.parse(pipResult.stdout);
        for (const vuln of auditData) {
          result.vulnerabilities.push({
            package: vuln.name,
            severity: vuln.vulns?.[0]?.severity || 'unknown',
            cve: vuln.vulns?.[0]?.id,
            fixAvailable: vuln.fix_versions?.length > 0
          });
        }
      }
    } catch {
      // pip-audit failed - continue
    }
  }

  return result;
}

// ---------------------------------------------------------------------------
// 5. Report Generation
// ---------------------------------------------------------------------------

/**
 * Generate security report
 * @param {object} findings - All findings
 * @returns {string}
 */
function generateReport(findings) {
  const { secrets, owasp, dependencies, passed } = findings;
  const report = [];

  report.push('╔════════════════════════════════════════════════════════════════╗');
  report.push('║               🔒 SECURITY SCAN REPORT                          ║');
  report.push('╚════════════════════════════════════════════════════════════════╝');
  report.push('');

  // Summary
  report.push('📋 SUMMARY:');
  report.push(`  Overall Status: ${passed ? '✅ PASS' : '❌ FAIL'}`);
  report.push(`  Secrets Found: ${secrets.length}`);
  report.push(`  OWASP Issues: ${owasp.length}`);
  report.push(`  CVE Vulnerabilities: ${dependencies.vulnerabilities.length}`);
  report.push('');

  // Secrets
  if (secrets.length > 0) {
    report.push('🔐 SECRETS DETECTED:');
    for (const secret of secrets) {
      report.push(`  [${secret.severity}] ${secret.type}`);
      report.push(`    File: ${secret.file}:${secret.line}`);
      report.push(`    Match: ${secret.match}`);
    }
    report.push('');
  }

  // OWASP
  if (owasp.length > 0) {
    report.push('⚠️ OWASP VULNERABILITIES:');
    for (const issue of owasp) {
      report.push(`  [${issue.severity}] ${issue.category}: ${issue.type}`);
      report.push(`    File: ${issue.file}:${issue.line}`);
      report.push(`    ${issue.description}`);
    }
    report.push('');
  }

  // Dependencies
  if (dependencies.vulnerabilities.length > 0) {
    report.push('📦 DEPENDENCY VULNERABILITIES:');
    for (const vuln of dependencies.vulnerabilities) {
      report.push(`  [${vuln.severity?.toUpperCase() || 'UNKNOWN'}] ${vuln.package}`);
      if (vuln.cve) report.push(`    CVE: ${vuln.cve}`);
      report.push(`    Fix Available: ${vuln.fixAvailable ? 'Yes' : 'No'}`);
    }
    report.push('');
  }

  // Decision
  report.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  if (passed) {
    report.push('✅ SECURITY SCAN PASSED');
  } else {
    report.push('❌ SECURITY SCAN FAILED');
    report.push('');
    report.push('Required Actions:');
    if (secrets.some(s => s.severity === 'CRITICAL')) {
      report.push('  • Remove or rotate CRITICAL secrets immediately');
    }
    if (owasp.some(o => o.severity === 'CRITICAL')) {
      report.push('  • Fix CRITICAL OWASP vulnerabilities');
    }
    if (dependencies.summary.critical > 0) {
      report.push('  • Update packages with CRITICAL CVEs');
    }
  }

  return report.join('\n');
}

// ---------------------------------------------------------------------------
// 6. Main Entry Point
// ---------------------------------------------------------------------------

/**
 * Get files to scan
 * @param {string} targetPath - Path to scan
 * @returns {string[]}
 */
/**
 * [수정시 주의] MAX_SCAN_DEPTH를 변경하면 스캔 범위가 달라짐
 */
const MAX_SCAN_DEPTH = 12;
const MAX_SCAN_FILES = 5000;

function getFilesToScan(targetPath = '.') {
  const extensions = ['.js', '.ts', '.jsx', '.tsx', '.py', '.go', '.java', '.rb', '.php', '.env', '.yaml', '.yml', '.json', '.xml', '.conf', '.config'];
  const ignoreDirs = ['node_modules', '.git', 'vendor', '__pycache__', '.venv', 'venv', 'dist', 'build'];
  const files = [];

  // 스캔 기준 경로를 정규화하여 경로 탈출 방지
  const basePath = path.resolve(targetPath);

  function walk(dir, depth) {
    if (depth > MAX_SCAN_DEPTH || files.length >= MAX_SCAN_FILES) return;

    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (files.length >= MAX_SCAN_FILES) return;

        const fullPath = path.join(dir, entry.name);

        // 심볼릭 링크를 따라갈 경우 basePath 외부로 나가는 것을 방지
        try {
          const realPath = fs.realpathSync(fullPath);
          if (!realPath.startsWith(basePath)) continue;
        } catch {
          continue;
        }

        if (entry.isDirectory()) {
          if (!ignoreDirs.includes(entry.name)) {
            walk(fullPath, depth + 1);
          }
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (extensions.includes(ext) || entry.name.startsWith('.env')) {
            files.push(fullPath);
          }
        }
      }
    } catch {
      // Directory access error - skip
    }
  }

  walk(basePath, 0);
  return files;
}

async function main() {
  try {
    const input = {
      hook_event_name: 'ManualHook',
      tool_name: 'security-scan',
      tool_input: {},
    };
    // Collect all findings
    const allSecrets = [];
    const allOwasp = [];

    // Scan files
    const files = getFilesToScan('.');
    for (const file of files) {
      const findings = scanFile(file);
      allSecrets.push(...findings.secrets);
      allOwasp.push(...findings.owasp);
    }

    // Scan dependencies
    const dependencies = scanDependencies();

    // Determine pass/fail
    const hasCriticalSecrets = allSecrets.some(s => s.severity === 'CRITICAL');
    const hasCriticalOwasp = allOwasp.some(o => o.severity === 'CRITICAL');
    const hasCriticalCve = dependencies.summary.critical > 0;

    const passed = !hasCriticalSecrets && !hasCriticalOwasp && !hasCriticalCve;

    // Generate report
    const findings = {
      secrets: allSecrets,
      owasp: allOwasp,
      dependencies,
      passed
    };

    const report = generateReport(findings);

    await emitHookDecision(input, {
      hook: 'security-scan',
      decision: passed ? 'approve' : 'block',
      severity: passed ? 'info' : (hasCriticalSecrets || hasCriticalOwasp || hasCriticalCve ? 'critical' : 'error'),
      risk_level: hasCriticalSecrets || hasCriticalOwasp || hasCriticalCve ? 'CRITICAL' : 'LOW',
      summary: `Security scan ${passed ? 'passed' : 'failed'} (${allSecrets.length} secret matches, ${allOwasp.length} OWASP findings, ${dependencies.vulnerabilities.length} dependency vulnerabilities).`,
      remediation: passed ? '' : 'Remediate critical findings and rerun the security scan.',
    });

    // Output JSON result (approve/block — Claude Code Stop Hook schema)
    process.stdout.write(JSON.stringify({
      decision: passed ? 'approve' : 'block',
      report,
      findings: {
        secrets: allSecrets.length,
        owasp: allOwasp.length,
        cve: dependencies.vulnerabilities.length
      },
      details: findings
    }));
  } catch (error) {
    console.error('[security-scan] Hook execution error:', error.message);
    await emitHookDecision({ hook_event_name: 'ManualHook', tool_name: 'security-scan', tool_input: {} }, {
      hook: 'security-scan',
      decision: 'approve',
      severity: 'warning',
      summary: `Security scan execution error: ${error.message}`,
      remediation: 'Review hook runtime errors and rerun.',
    });
    // Error fallback — approve to avoid blocking the session (fail-open)
    process.stdout.write(JSON.stringify({
      decision: 'approve',
      reason: `Security scan error (fail-open): ${error.message}`
    }));
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error('[security-scan] Unhandled error:', err.message);
  });
}

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    SECRET_PATTERNS,
    OWASP_PATTERNS,
    scanFile,
    scanDependencies,
    generateReport,
    getFilesToScan,
    maskSecret
  };
}
