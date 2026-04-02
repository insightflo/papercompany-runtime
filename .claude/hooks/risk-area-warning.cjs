#!/usr/bin/env node
/**
 * PreToolUse[Edit] Hook: Risk Area Warning
 *
 * Warns when modifications target risk-sensitive areas of the codebase.
 * Classifies files by risk level (CRITICAL, HIGH, MEDIUM, LOW) using
 * glob pattern matching against a configurable risk area registry.
 * Shows confirmation checklists and required reviewers for high-risk edits.
 *
 * @TASK P3-T2 - Risk Area Warning Hook
 * @SPEC project-team/hooks (Section 12.4)
 *
 * Claude Code Hook Protocol (PreToolUse):
 *   - stdin: JSON { tool_name, tool_input: { file_path, ... } }
 *   - stdout: JSON { hookSpecificOutput: { additionalContext: "..." } }
 *
 * Risk Levels (from risk-areas.yaml):
 *   - CRITICAL: payment, billing, auth (reviewers: qa-manager, chief-architect)
 *   - HIGH: services/*_service.py, core (reviewers: part-leader)
 *   - MEDIUM: api, models
 *   - LOW: tests, utils
 */

const path = require('path');
const fs = require('fs');

// ---------------------------------------------------------------------------
// 1. Risk Level Constants
// ---------------------------------------------------------------------------

/**
 * Risk level priority values (lower = higher priority).
 */
const RISK_LEVELS = {
  CRITICAL: 0,
  HIGH: 1,
  MEDIUM: 2,
  LOW: 3
};

/**
 * Risk level display labels with visual indicators.
 */
const RISK_LABELS = {
  CRITICAL: '[CRITICAL]',
  HIGH: '[HIGH]',
  MEDIUM: '[MEDIUM]',
  LOW: '[LOW]'
};

// ---------------------------------------------------------------------------
// 2. Glob Pattern Matching (no external dependencies)
// ---------------------------------------------------------------------------

/**
 * Convert a glob pattern to a RegExp.
 *
 * Supported syntax:
 *   ** - matches any number of path segments (including zero)
 *   *  - matches any characters within a single path segment (no /)
 *   ?  - matches exactly one character (not /)
 *   {a,b} - alternation (matches a or b)
 *   [abc] - character class
 *
 * @param {string} pattern - Glob pattern (e.g., "** /payment/**")
 * @returns {RegExp} Compiled regular expression
 */
function globToRegex(pattern) {
  if (!pattern) return /^$/;

  let i = 0;
  let regex = '';
  const len = pattern.length;

  while (i < len) {
    const ch = pattern[i];

    if (ch === '*') {
      if (i + 1 < len && pattern[i + 1] === '*') {
        // ** - match any path segments
        // Check if surrounded by / or at start/end
        const prevIsSlashOrStart = (i === 0 || pattern[i - 1] === '/');
        const nextAfterStars = i + 2;
        const nextIsSlashOrEnd = (nextAfterStars >= len || pattern[nextAfterStars] === '/');

        if (prevIsSlashOrStart && nextIsSlashOrEnd) {
          // **/ or /** or /**/  ->  match zero or more path segments
          if (nextAfterStars < len && pattern[nextAfterStars] === '/') {
            regex += '(?:.+/)?';
            i = nextAfterStars + 1; // skip past **/
          } else {
            regex += '.*';
            i = nextAfterStars;
          }
        } else {
          // ** not surrounded by slashes -> treat as two wildcards
          regex += '[^/]*[^/]*';
          i += 2;
        }
      } else {
        // Single * - match within a single path segment
        regex += '[^/]*';
        i++;
      }
    } else if (ch === '?') {
      regex += '[^/]';
      i++;
    } else if (ch === '{') {
      // Brace expansion: {a,b,c}
      const closeBrace = pattern.indexOf('}', i);
      if (closeBrace === -1) {
        regex += '\\{';
        i++;
      } else {
        const alternatives = pattern.slice(i + 1, closeBrace).split(',');
        const altPatterns = alternatives.map(alt => {
          // Recursively convert each alternative (may contain globs)
          return globToRegex(alt).source.slice(1, -1); // strip ^...$
        });
        regex += '(?:' + altPatterns.join('|') + ')';
        i = closeBrace + 1;
      }
    } else if (ch === '[') {
      // Character class
      const closeBracket = pattern.indexOf(']', i);
      if (closeBracket === -1) {
        regex += '\\[';
        i++;
      } else {
        regex += pattern.slice(i, closeBracket + 1);
        i = closeBracket + 1;
      }
    } else if ('.+^${}()|\\'.includes(ch)) {
      // Escape regex metacharacters
      regex += '\\' + ch;
      i++;
    } else {
      regex += ch;
      i++;
    }
  }

  return new RegExp('^' + regex + '$');
}

/**
 * Test if a file path matches a glob pattern.
 *
 * @param {string} filePath - The file path to test
 * @param {string} pattern - The glob pattern
 * @returns {boolean} True if the path matches the pattern
 */
function matchGlob(filePath, pattern) {
  if (!filePath || !pattern) return false;
  const regex = globToRegex(pattern);
  return regex.test(filePath);
}

/**
 * Test if a file path matches any of the given glob patterns.
 *
 * @param {string} filePath - The file path to test
 * @param {string[]} patterns - Array of glob patterns
 * @returns {boolean} True if the path matches any pattern
 */
function matchesAnyPattern(filePath, patterns) {
  if (!filePath || !patterns || patterns.length === 0) return false;
  return patterns.some(pattern => matchGlob(filePath, pattern));
}

// ---------------------------------------------------------------------------
// 3. Risk Area Registry
// ---------------------------------------------------------------------------

/**
 * Default risk area configuration.
 * Equivalent to risk-areas.yaml content defined in Section 12.4.
 *
 * Each entry defines:
 *   - level: Risk classification
 *   - patterns: Glob patterns matching file paths
 *   - reviewers: Required reviewers for this risk level
 *   - reason: Human-readable explanation of why this area is risky
 */
const DEFAULT_RISK_AREAS = [
  {
    level: 'CRITICAL',
    patterns: [
      '**/payment/**',
      '**/billing/**',
      '**/auth/**'
    ],
    reviewers: ['qa-manager', 'chief-architect'],
    reason: 'Financial transaction or authentication/authorization logic. '
      + 'Bugs here can cause monetary loss, data breaches, or security vulnerabilities.'
  },
  {
    level: 'HIGH',
    patterns: [
      '**/services/*_service.py',
      '**/services/*_service.js',
      '**/services/*_service.ts',
      '**/core/**'
    ],
    reviewers: ['part-leader'],
    reason: 'Core business logic or shared service layer. '
      + 'Changes propagate to multiple consumers and may cause cascading failures.'
  },
  {
    level: 'MEDIUM',
    patterns: [
      '**/api/**',
      '**/models/**'
    ],
    reviewers: [],
    reason: 'API interface or data model layer. '
      + 'Changes may break contract compatibility with clients or data integrity.'
  },
  {
    level: 'LOW',
    patterns: [
      '**/tests/**',
      '**/utils/**'
    ],
    reviewers: [],
    reason: 'Test or utility code with minimal blast radius. Standard review applies.'
  }
];

// ---------------------------------------------------------------------------
// 4. Risk Area Configuration Loading
// ---------------------------------------------------------------------------

/**
 * Load risk area configuration from risk-areas.yaml file if available.
 * Falls back to DEFAULT_RISK_AREAS if file is not found or cannot be parsed.
 *
 * Supports a simple YAML-like format:
 *   - level: CRITICAL
 *     patterns:
 *       - "** /payment/**"
 *     reviewers:
 *       - qa-manager
 *     reason: "..."
 *
 * @param {string} [configPath] - Path to risk-areas.yaml
 * @returns {object[]} Array of risk area definitions
 */
function loadRiskAreas(configPath) {
  if (!configPath) return DEFAULT_RISK_AREAS;

  try {
    const content = fs.readFileSync(configPath, 'utf8');
    return parseRiskAreasYaml(content);
  } catch {
    return DEFAULT_RISK_AREAS;
  }
}

/**
 * Parse a simple YAML-like risk areas configuration.
 * This is a minimal parser for the specific risk-areas.yaml format,
 * avoiding any external YAML parsing dependency.
 *
 * @param {string} content - YAML content
 * @returns {object[]} Parsed risk area definitions
 */
function parseRiskAreasYaml(content) {
  if (!content || !content.trim()) return DEFAULT_RISK_AREAS;

  const areas = [];
  const lines = content.split('\n');
  let current = null;
  let currentList = null; // 'patterns' | 'reviewers' | null

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    // New risk area entry: "- level: CRITICAL"
    if (trimmed.match(/^-\s+level:\s*/)) {
      if (current) areas.push(current);
      const level = trimmed.replace(/^-\s+level:\s*/, '').trim().toUpperCase();
      current = { level, patterns: [], reviewers: [], reason: '' };
      currentList = null;
      continue;
    }

    if (!current) continue;

    // List headers
    if (trimmed === 'patterns:') {
      currentList = 'patterns';
      continue;
    }
    if (trimmed === 'reviewers:') {
      currentList = 'reviewers';
      continue;
    }

    // Reason field: "reason: ..."
    if (trimmed.startsWith('reason:')) {
      current.reason = trimmed.replace(/^reason:\s*/, '').replace(/^["']|["']$/g, '');
      currentList = null;
      continue;
    }

    // List items: "- value" or '- "value"'
    if (trimmed.startsWith('- ') && currentList) {
      const value = trimmed.slice(2).trim().replace(/^["']|["']$/g, '');
      current[currentList].push(value);
      continue;
    }
  }

  if (current) areas.push(current);

  return areas.length > 0 ? areas : DEFAULT_RISK_AREAS;
}

// ---------------------------------------------------------------------------
// 5. Risk Classification
// ---------------------------------------------------------------------------

/**
 * Classify the risk level of a file based on its path.
 * Checks all risk areas and returns the highest priority match.
 * CRITICAL > HIGH > MEDIUM > LOW.
 * Files matching no pattern are considered unclassified (null).
 *
 * @param {string} filePath - Relative file path
 * @param {object[]} [riskAreas] - Risk area configuration (default: DEFAULT_RISK_AREAS)
 * @returns {{ level: string, area: object } | null} Matching risk info or null
 */
function classifyRiskLevel(filePath, riskAreas) {
  if (!filePath) return null;

  const areas = riskAreas || DEFAULT_RISK_AREAS;
  let bestMatch = null;
  let bestPriority = Infinity;

  for (const area of areas) {
    const priority = RISK_LEVELS[area.level];
    if (priority === undefined) continue;

    // Only check if this area could improve the current best
    if (priority >= bestPriority) continue;

    if (matchesAnyPattern(filePath, area.patterns)) {
      bestMatch = area;
      bestPriority = priority;
    }
  }

  if (!bestMatch) return null;

  return {
    level: bestMatch.level,
    area: bestMatch
  };
}

/**
 * Get the risk level string for a file path.
 * Returns 'NONE' for unclassified files.
 *
 * @param {string} filePath
 * @param {object[]} [riskAreas]
 * @returns {string}
 */
function getRiskLevel(filePath, riskAreas) {
  const result = classifyRiskLevel(filePath, riskAreas);
  return result ? result.level : 'NONE';
}

// ---------------------------------------------------------------------------
// 6. Confirmation Checklist
// ---------------------------------------------------------------------------

/**
 * Generate a confirmation checklist for CRITICAL/HIGH risk edits.
 *
 * @param {string} level - Risk level
 * @param {object} area - Risk area definition
 * @returns {string[]} Array of checklist items
 */
function generateChecklist(level, area) {
  const checklist = [];

  if (level === 'CRITICAL') {
    checklist.push(
      'Verify no financial/monetary calculation errors',
      'Confirm no security vulnerabilities introduced',
      'Check authentication/authorization logic is intact',
      'Ensure full test coverage for modified code paths',
      'Review for sensitive data exposure (PII, credentials)',
      'Validate input sanitization and output encoding'
    );
  } else if (level === 'HIGH') {
    checklist.push(
      'Verify backward compatibility with existing consumers',
      'Check for cascading side effects in dependent modules',
      'Run full test suite for the affected service domain',
      'Review shared state and concurrency implications'
    );
  }

  // Add reviewer-specific items
  if (area && area.reviewers && area.reviewers.length > 0) {
    checklist.push(
      `Obtain approval from required reviewers: ${area.reviewers.join(', ')}`
    );
  }

  return checklist;
}

// ---------------------------------------------------------------------------
// 7. Warning Report Formatting
// ---------------------------------------------------------------------------

/**
 * Format a risk area warning report.
 *
 * @param {object} params
 * @param {string} params.filePath - The file being edited
 * @param {string} params.level - Risk level
 * @param {object} params.area - Risk area definition
 * @param {string[]} params.matchedPatterns - Which patterns matched
 * @returns {string} Formatted warning report
 */
function formatWarningReport({ filePath, level, area, matchedPatterns }) {
  let report = '';

  // Header
  report += `\n[Risk Area Warning] ${RISK_LABELS[level] || '[UNKNOWN]'} File: "${filePath}"`;

  // Risk reason
  if (area && area.reason) {
    report += `\n  Reason: ${area.reason}`;
  }

  // Matched patterns
  if (matchedPatterns && matchedPatterns.length > 0) {
    report += '\n\n  Matched Patterns:';
    for (const p of matchedPatterns) {
      report += `\n    - ${p}`;
    }
  }

  // Required reviewers (CRITICAL/HIGH)
  if (area && area.reviewers && area.reviewers.length > 0) {
    report += '\n\n  Required Reviewers:';
    for (const reviewer of area.reviewers) {
      report += `\n    - ${reviewer}`;
    }
  }

  // Confirmation checklist (CRITICAL/HIGH)
  if (level === 'CRITICAL' || level === 'HIGH') {
    const checklist = generateChecklist(level, area);
    if (checklist.length > 0) {
      report += '\n\n  Confirmation Checklist (verify before proceeding):';
      for (let i = 0; i < checklist.length; i++) {
        report += `\n    [ ] ${checklist[i]}`;
      }
    }
  }

  // Level-specific warnings
  if (level === 'CRITICAL') {
    report += '\n\n  [WARNING] This file is in a CRITICAL risk area. '
      + 'Any changes require thorough review by qa-manager and chief-architect before merging. '
      + 'Proceed with extreme caution.';
  } else if (level === 'HIGH') {
    report += '\n\n  [CAUTION] This file is in a HIGH risk area. '
      + 'Changes should be reviewed by the part-leader and tested thoroughly.';
  } else if (level === 'MEDIUM') {
    report += '\n\n  [NOTE] This file is in a MEDIUM risk area. '
      + 'Verify contract compatibility and run related tests.';
  }

  return report;
}

// ---------------------------------------------------------------------------
// 8. Pattern Matching Details
// ---------------------------------------------------------------------------

/**
 * Find which specific patterns from a risk area matched the file path.
 *
 * @param {string} filePath - The file path to check
 * @param {object} area - Risk area definition with patterns
 * @returns {string[]} Array of matched pattern strings
 */
function findMatchedPatterns(filePath, area) {
  if (!filePath || !area || !area.patterns) return [];
  return area.patterns.filter(pattern => matchGlob(filePath, pattern));
}

// ---------------------------------------------------------------------------
// 9. Risk Analysis (Integration)
// ---------------------------------------------------------------------------

/**
 * Perform complete risk area analysis for a file edit.
 *
 * @param {string} filePath - Relative file path
 * @param {object[]} [riskAreas] - Risk area configuration
 * @returns {object|null} Analysis result or null if no risk detected
 */
function analyzeRisk(filePath, riskAreas) {
  if (!filePath) return null;

  const areas = riskAreas || DEFAULT_RISK_AREAS;
  const classification = classifyRiskLevel(filePath, areas);

  if (!classification) return null;

  const { level, area } = classification;
  const matchedPatterns = findMatchedPatterns(filePath, area);
  const checklist = (level === 'CRITICAL' || level === 'HIGH')
    ? generateChecklist(level, area)
    : [];

  return {
    filePath,
    level,
    area,
    matchedPatterns,
    reviewers: area.reviewers || [],
    reason: area.reason || '',
    checklist,
    requiresReview: level === 'CRITICAL' || level === 'HIGH'
  };
}

// ---------------------------------------------------------------------------
// 10. Relative Path Resolution
// ---------------------------------------------------------------------------

/**
 * Convert an absolute file path to a project-relative path.
 *
 * @param {string} filePath - Absolute or relative file path
 * @returns {string} Project-relative path
 */
function toRelativePath(filePath) {
  if (!filePath) return '';

  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();

  if (!path.isAbsolute(filePath)) return filePath;

  const relative = path.relative(projectDir, filePath);
  if (relative.startsWith('..')) return relative;

  return relative;
}

// ---------------------------------------------------------------------------
// 11. stdin/stdout Helpers (Claude Code Hook Protocol)
// ---------------------------------------------------------------------------

let _hookEventName = '';

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
        _hookEventName = parsed.hook_event_name || '';
        resolve(parsed);
      } catch {
        resolve({});
      }
    });
    process.stdin.on('error', () => resolve({}));
  });
}

/**
 * Output additional context (PreToolUse guidance).
 * @param {string} context
 */
function outputContext(context) {
  const hookSpecificOutput = { additionalContext: context };
  if (_hookEventName) hookSpecificOutput.hookEventName = _hookEventName;
  process.stdout.write(JSON.stringify({ hookSpecificOutput }));
}

// ---------------------------------------------------------------------------
// 12. Main Hook Entry Point
// ---------------------------------------------------------------------------

async function main() {
  const input = await readStdin();

  // Extract file path from tool input
  const toolInput = input.tool_input || {};
  const filePath = toolInput.file_path || toolInput.path || '';

  if (!filePath) return; // No file path = nothing to check

  // Convert to project-relative path
  const relativePath = toRelativePath(filePath);

  // Skip files outside project directory
  if (relativePath.startsWith('..')) return;

  // Try to load risk-areas.yaml from project
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const configCandidates = [
    path.join(projectDir, '.claude', 'risk-areas.yaml'),
    path.join(projectDir, 'risk-areas.yaml'),
    path.join(projectDir, '.claude', 'risk-areas.yml')
  ];

  let riskAreas = DEFAULT_RISK_AREAS;
  for (const candidate of configCandidates) {
    try {
      if (fs.existsSync(candidate)) {
        riskAreas = loadRiskAreas(candidate);
        break;
      }
    } catch {
      // Continue to next candidate
    }
  }

  // Perform risk analysis
  const analysis = analyzeRisk(relativePath, riskAreas);

  // If no risk area matched, skip output (LOW or unclassified)
  if (!analysis) return;

  // Only output warnings for CRITICAL, HIGH, and MEDIUM
  // LOW risk areas get no warning (standard review applies)
  if (analysis.level === 'LOW') return;

  // Format and output warning report
  const report = formatWarningReport({
    filePath: relativePath,
    level: analysis.level,
    area: analysis.area,
    matchedPatterns: analysis.matchedPatterns
  });

  if (report) {
    outputContext(report);
  }
}

main().catch((err) => {
  console.error('[risk-area-warning] Unhandled error:', err.message);
});

// ---------------------------------------------------------------------------
// Exports for testing
// ---------------------------------------------------------------------------

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    RISK_LEVELS,
    RISK_LABELS,
    DEFAULT_RISK_AREAS,
    globToRegex,
    matchGlob,
    matchesAnyPattern,
    loadRiskAreas,
    parseRiskAreasYaml,
    classifyRiskLevel,
    getRiskLevel,
    generateChecklist,
    formatWarningReport,
    findMatchedPatterns,
    analyzeRisk,
    toRelativePath
  };
}
