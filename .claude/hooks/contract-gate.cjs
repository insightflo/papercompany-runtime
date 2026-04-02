#!/usr/bin/env node
/**
 * Integrated Hook: Contract Gate
 *
 * Combines interface-validator + cross-domain-notifier
 * into a unified API contract enforcement pipeline.
 *
 * Phase 2 Hook Consolidation
 *
 * Features:
 *   - API contract validation (OpenAPI/Interface spec compliance)
 *   - Breaking change detection
 *   - Cross-domain impact notification
 *   - Version compatibility checking
 *
 * Claude Code Hook Protocol:
 *   - stdin: JSON { hook_event_name, tool_name, tool_input, tool_result? }
 *   - stdout: JSON { hookSpecificOutput: { additionalContext } }
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 1. Contract Patterns
// ---------------------------------------------------------------------------

const CONTRACT_PATTERNS = {
  api_definition: ['contracts/interfaces/**', 'api/**/*.yaml', 'api/**/*.json'],
  api_implementation: ['src/**/routes/**', 'src/**/api/**', 'src/**/controllers/**'],
  type_definition: ['src/**/types/**', 'src/**/models/**', 'src/**/schemas/**']
};

const BREAKING_CHANGE_PATTERNS = [
  // Endpoint removal
  { pattern: /^-\s*(get|post|put|patch|delete)\s*:/i, severity: 'critical', type: 'endpoint_removed' },
  // Required field added
  { pattern: /^\+.*required:\s*true/i, severity: 'high', type: 'required_field_added' },
  // Type change
  { pattern: /^-\s*type:\s*(\w+)[\s\S]*?^\+\s*type:\s*(?!\1)/m, severity: 'high', type: 'type_changed' },
  // Response status removed
  { pattern: /^-\s*['"]?(2\d{2}|4\d{2}|5\d{2})['"]?\s*:/i, severity: 'medium', type: 'response_status_removed' }
];

// ---------------------------------------------------------------------------
// 2. Domain Detection
// ---------------------------------------------------------------------------

function detectDomain(filePath) {
  // Pattern: src/domains/{domain}/...
  const domainMatch = filePath.match(/src\/domains\/([^/]+)\//);
  if (domainMatch) return domainMatch[1];

  // Pattern: contracts/interfaces/{domain}-api.yaml
  const contractMatch = filePath.match(/contracts\/interfaces\/([^-]+)-/);
  if (contractMatch) return contractMatch[1];

  return null;
}

function detectAffectedDomains(filePath, content) {
  const affected = new Set();
  const sourceDomain = detectDomain(filePath);

  if (sourceDomain) affected.add(sourceDomain);

  // Check for cross-domain imports
  const importPatterns = [
    /from\s+['"].*\/domains\/([^/'"]+)/g,
    /import\s+.*from\s+['"]@domains\/([^/'"]+)/g,
    /require\(['"].*\/domains\/([^/'"]+)/g
  ];

  for (const pattern of importPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      affected.add(match[1]);
    }
  }

  return Array.from(affected);
}

// ---------------------------------------------------------------------------
// 3. Contract Validation
// ---------------------------------------------------------------------------

function isContractFile(filePath) {
  const patterns = [
    ...CONTRACT_PATTERNS.api_definition,
    ...CONTRACT_PATTERNS.type_definition
  ];

  for (const pattern of patterns) {
    const regex = pattern
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*');
    if (new RegExp(regex).test(filePath)) return true;
  }
  return false;
}

function detectBreakingChanges(oldContent, newContent) {
  const changes = [];

  // Simple diff comparison
  const oldLines = (oldContent || '').split('\n');
  const newLines = (newContent || '').split('\n');

  // Create a simple diff representation
  const removedLines = oldLines.filter(l => !newLines.includes(l));
  const addedLines = newLines.filter(l => !oldLines.includes(l));

  // Check for breaking patterns
  for (const removed of removedLines) {
    for (const pattern of BREAKING_CHANGE_PATTERNS) {
      if (pattern.pattern.test(`- ${removed}`)) {
        changes.push({
          type: pattern.type,
          severity: pattern.severity,
          line: removed.trim()
        });
      }
    }
  }

  return changes;
}

function validateContractCompliance(content, filePath) {
  const issues = [];
  const ext = path.extname(filePath);

  // YAML/JSON contract files
  if (['.yaml', '.yml', '.json'].includes(ext)) {
    // Check for version field
    if (!content.includes('version:') && !content.includes('"version"')) {
      issues.push({
        type: 'missing_version',
        severity: 'warning',
        message: 'Contract file should include version field for tracking changes.'
      });
    }

    // Check for description
    if (!content.includes('description:') && !content.includes('"description"')) {
      issues.push({
        type: 'missing_description',
        severity: 'info',
        message: 'Consider adding description field to contract.'
      });
    }
  }

  // TypeScript interface files
  if (['.ts', '.tsx'].includes(ext)) {
    // Check for JSDoc on interfaces
    const interfaces = content.match(/export\s+interface\s+\w+/g) || [];
    for (const iface of interfaces) {
      const name = iface.match(/interface\s+(\w+)/)?.[1];
      if (name && !content.includes(`/** `) && !content.includes(`* @interface ${name}`)) {
        issues.push({
          type: 'missing_jsdoc',
          severity: 'info',
          message: `Interface "${name}" should have JSDoc documentation.`
        });
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// 4. Cross-Domain Notification
// ---------------------------------------------------------------------------

function generateNotification(sourceDomain, affectedDomains, changes) {
  if (affectedDomains.length === 0 && changes.length === 0) return null;

  let notification = `\n[Contract Gate] API Contract Change Detected\n`;
  notification += `  Source Domain: ${sourceDomain || 'unknown'}\n`;

  if (affectedDomains.length > 1) {
    notification += `  Affected Domains: ${affectedDomains.join(', ')}\n`;
    notification += `\n  ⚠️ Cross-Domain Impact: Changes may affect other domains.\n`;
    notification += `     Please coordinate with affected domain Part Leaders.\n`;
  }

  if (changes.length > 0) {
    notification += `\n  Breaking Changes Detected:\n`;
    for (const change of changes) {
      const icon = change.severity === 'critical' ? '🔴' :
        change.severity === 'high' ? '🟠' : '🟡';
      notification += `    ${icon} [${change.severity.toUpperCase()}] ${change.type}\n`;
      if (change.line) {
        notification += `       Line: ${change.line.substring(0, 60)}...\n`;
      }
    }
    notification += `\n  Protocol: Use contracts/change-requests/ to coordinate changes.\n`;
  }

  return notification;
}

// ---------------------------------------------------------------------------
// 5. Report Formatting
// ---------------------------------------------------------------------------

function formatContractReport(issues, notification, filePath) {
  let report = '';

  if (issues.length > 0) {
    report += `\n[Contract Gate] ${issues.length} contract issue(s) in "${filePath}"\n`;
    for (const issue of issues) {
      const icon = issue.severity === 'warning' ? '[WARN]' :
        issue.severity === 'info' ? '[INFO]' : '[ERROR]';
      report += `  ${icon} ${issue.message}\n`;
    }
  }

  if (notification) {
    report += notification;
  }

  return report;
}

// ---------------------------------------------------------------------------
// 6. Main Entry Point
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

function toRelativePath(filePath) {
  if (!filePath) return '';
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  if (!path.isAbsolute(filePath)) return filePath;
  const relative = path.relative(projectDir, filePath);
  return relative.startsWith('..') ? relative : relative;
}

async function main() {
  const input = await readStdin();
  const hookEvent = input.hook_event_name || '';
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || '';

  if (!filePath) return;

  const relativePath = toRelativePath(filePath);
  if (relativePath.startsWith('..')) return;

  // Only process contract-related files
  if (!isContractFile(relativePath)) return;

  const content = toolInput.content || toolInput.new_string || '';
  if (!content) return;

  // Validate contract
  const issues = validateContractCompliance(content, relativePath);

  // Detect affected domains
  const affectedDomains = detectAffectedDomains(relativePath, content);

  // Check for breaking changes (would need old content for real diff)
  const breakingChanges = []; // Simplified - would compare with git history

  // Generate notification if cross-domain impact
  const sourceDomain = detectDomain(relativePath);
  const notification = generateNotification(sourceDomain, affectedDomains, breakingChanges);

  // Output report
  const report = formatContractReport(issues, notification, relativePath);

  if (report) {
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: {
        additionalContext: report,
        hookEventName: hookEvent
      }
    }));
  }
}

main().catch((err) => { console.error('[contract-gate] Unhandled error:', err.message); });

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    CONTRACT_PATTERNS,
    BREAKING_CHANGE_PATTERNS,
    detectDomain,
    detectAffectedDomains,
    isContractFile,
    validateContractCompliance,
    generateNotification,
    formatContractReport
  };
}
