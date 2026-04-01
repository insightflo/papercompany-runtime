#!/usr/bin/env node

/**
 * Long Context Optimizer Service
 *
 * Applies H2O (Heavy-Hitter Oracle) and Compressive Context patterns
 * to optimize long context for LLM processing.
 *
 * Techniques:
 * - Heavy-Hitter extraction: Preserve critical info at the top
 * - Compressive Context: Summarize older/less important content
 * - RAG Hybrid: Retrieve → Prioritize → Compress → Synthesize
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

// ============================================
// Configuration
// ============================================

const DEFAULT_CONFIG = {
  maxTokens: 8000,        // Target token limit
  heavyHitterCount: 10,   // Number of key insights to extract
  summaryRatio: 0.3       // Ratio of content to compress
};

// ============================================
// Enhanced Scoring System (H2O Heuristic v2)
// ============================================

/**
 * Priority scores for different content types
 * Lower number = higher priority (will appear first)
 */
const PRIORITY_SCORES = {
  // Headers by depth (shallower = more important)
  h1: 1,
  h2: 2,
  h3: 3,
  h4: 4,
  // Code definitions
  classDef: 1,
  functionDef: 2,
  interfaceDef: 2,
  typeDef: 2,
  constExport: 3,
  // Document structures
  tableHeader: 2,
  codeBlockStart: 3,
  importantMarker: 1,  // ⚠️, 🔥, IMPORTANT, CRITICAL, etc.
  // Lists and YAML
  listItem: 4,
  yamlKey: 4,
  // Position bonuses (applied as multiplier)
  positionBonus: {
    first10Percent: 0.8,   // 20% priority boost for top 10%
    last10Percent: 0.9,    // 10% priority boost for bottom 10%
    middle: 1.0            // no bonus
  }
};

/**
 * Important keywords that boost priority
 */
const IMPORTANT_KEYWORDS = [
  /\b(CRITICAL|IMPORTANT|WARNING|BREAKING|REQUIRED|MUST|TODO)\b/i,
  /\b(핵심|중요|필수|주의|경고)\b/,
  /[⚠️🔥💥🚨❗❌✅]/
];

// ============================================
// H2O: Heavy-Hitter Extraction (Enhanced v2)
// ============================================

/**
 * Calculate position bonus based on line index
 */
function getPositionBonus(lineIndex, totalLines) {
  const position = lineIndex / totalLines;
  if (position < 0.1) return PRIORITY_SCORES.positionBonus.first10Percent;
  if (position > 0.9) return PRIORITY_SCORES.positionBonus.last10Percent;
  return PRIORITY_SCORES.positionBonus.middle;
}

/**
 * Check if line contains important keywords
 */
function hasImportantKeyword(line) {
  return IMPORTANT_KEYWORDS.some(pattern => pattern.test(line));
}

/**
 * Classify and score a line of content
 * Returns null if not a heavy-hitter candidate
 */
function classifyLine(line, lineIndex, totalLines) {
  const trimmed = line.trim();
  if (!trimmed || trimmed.length < 3) return null;

  let type = null;
  let basePriority = 999;

  // === Headers (depth-based priority) ===
  const headerMatch = trimmed.match(/^(#{1,6})\s+(.+)/);
  if (headerMatch) {
    const depth = headerMatch[1].length;
    type = `h${depth}`;
    basePriority = PRIORITY_SCORES[type] || depth;
  }

  // === Code definitions ===
  else if (trimmed.match(/^(export\s+)?(abstract\s+)?class\s+\w+/)) {
    type = 'classDef';
    basePriority = PRIORITY_SCORES.classDef;
  }
  else if (trimmed.match(/^(export\s+)?(async\s+)?function\s+\w+/)) {
    type = 'functionDef';
    basePriority = PRIORITY_SCORES.functionDef;
  }
  else if (trimmed.match(/^(export\s+)?interface\s+\w+/)) {
    type = 'interfaceDef';
    basePriority = PRIORITY_SCORES.interfaceDef;
  }
  else if (trimmed.match(/^(export\s+)?type\s+\w+/)) {
    type = 'typeDef';
    basePriority = PRIORITY_SCORES.typeDef;
  }
  else if (trimmed.match(/^(export\s+)?const\s+\w+/)) {
    type = 'constExport';
    basePriority = PRIORITY_SCORES.constExport;
  }

  // === Table headers ===
  else if (trimmed.match(/^\|.+\|/) && trimmed.includes('|')) {
    // Only capture header rows (first row or row after separator)
    if (!trimmed.match(/^\|[-:\s|]+\|$/)) {
      type = 'tableHeader';
      basePriority = PRIORITY_SCORES.tableHeader;
    }
  }

  // === Code block starts ===
  else if (trimmed.match(/^```\w+/)) {
    type = 'codeBlockStart';
    basePriority = PRIORITY_SCORES.codeBlockStart;
  }

  // === Lists ===
  else if (trimmed.match(/^[-*+]\s+\S+/) || trimmed.match(/^\d+\.\s+\S+/)) {
    type = 'listItem';
    basePriority = PRIORITY_SCORES.listItem;
  }

  // === YAML keys ===
  else if (trimmed.match(/^[a-zA-Z_]\w*:\s*.+/)) {
    type = 'yamlKey';
    basePriority = PRIORITY_SCORES.yamlKey;
  }

  if (!type) return null;

  // Apply modifiers
  let finalPriority = basePriority;

  // Position bonus (multiply)
  finalPriority *= getPositionBonus(lineIndex, totalLines);

  // Important keyword bonus (reduce priority = higher rank)
  if (hasImportantKeyword(trimmed)) {
    finalPriority *= 0.5; // 50% priority boost
    type = 'importantMarker';
  }

  return {
    type,
    priority: finalPriority,
    content: trimmed,
    lineIndex
  };
}

/**
 * Extract heavy-hitter tokens from content (Enhanced v2)
 * Uses depth-based header scoring, position bonuses, and keyword detection
 */
function extractHeavyHitters(content, options = {}) {
  const { maxCount = 10 } = options;
  const lines = content.split('\n');
  const totalLines = lines.length;
  const candidates = [];

  // Classify all lines
  for (let i = 0; i < lines.length; i++) {
    const classified = classifyLine(lines[i], i, totalLines);
    if (classified) {
      candidates.push(classified);
    }
  }

  // Sort by priority (lower = more important) then by line index (earlier = first)
  candidates.sort((a, b) => {
    if (Math.abs(a.priority - b.priority) < 0.1) {
      return a.lineIndex - b.lineIndex; // Same priority: keep original order
    }
    return a.priority - b.priority;
  });

  // Take top N
  const heavyHitters = candidates.slice(0, maxCount).map(h => ({
    type: h.type,
    priority: Math.round(h.priority * 100) / 100,
    content: h.content
  }));

  return {
    heavyHitters,
    totalCount: candidates.length,
    compressionRatio: candidates.length / totalLines
  };
}

/**
 * Structure context with heavy-hitters at the top
 */
function structureContext(contexts, options = {}) {
  const structured = [];

  for (const ctx of contexts) {
    const { type, content, source } = ctx;
    const extracted = extractHeavyHitters(content, options);

    structured.push({
      source,
      type,
      heavyHitters: extracted.heavyHitters,
      summary: compressContent(content, options),
      originalLength: content.length,
      compressedLength: Math.floor(content.length * (1 - options.summaryRatio || DEFAULT_CONFIG.summaryRatio))
    });
  }

  // Sort by importance (heavyHitters count desc)
  return structured.sort((a, b) => b.heavyHitters.length - a.heavyHitters.length);
}

// ============================================
// Compressive Context
// ============================================

/**
 * Compress content by importance
 * Recent/critical content preserved, older content summarized
 */
function compressContent(content, options = {}) {
  const { summaryRatio = DEFAULT_CONFIG.summaryRatio, preserveLines = 5 } = options;
  const lines = content.split('\n');
  const totalLines = lines.length;
  const targetLines = Math.max(preserveLines, Math.floor(totalLines * summaryRatio));

  if (totalLines <= targetLines) return content;

  // Keep header (first N lines)
  const header = lines.slice(0, preserveLines);
  // Keep footer (last N lines)
  const footer = lines.slice(-preserveLines);
  // Compress middle section
  const middle = lines.slice(preserveLines, -preserveLines);

  // Sample middle section
  const sampleStep = Math.max(1, Math.floor(middle.length / (targetLines - preserveLines * 2)));
  const sampled = middle.filter((_, i) => i % sampleStep === 0);

  return [...header, '... (compressed)', ...sampled, '... (compressed)', ...footer].join('\n');
}

// ============================================
// LLM-Based Compression (Phase B)
// ============================================

/**
 * Check if Claude CLI is available and not in nested session
 */
function isClaudeCliAvailable() {
  // Cannot call claude CLI from within Claude Code session
  if (process.env.CLAUDECODE) {
    return false;
  }

  try {
    execSync('which claude', { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Call Claude CLI with a prompt (uses subscription, no extra cost)
 * @param {string} prompt - The prompt to send
 * @param {object} options - Options for the CLI call
 * @returns {string} - Claude's response
 */
function callClaudeCli(prompt, options = {}) {
  const { model = 'haiku', maxTokens = 1000, timeout = 30000 } = options;

  try {
    // Create temp file for prompt (avoids shell escaping issues)
    const tempFile = `/tmp/claude-prompt-${Date.now()}.txt`;
    fs.writeFileSync(tempFile, prompt);

    const result = execSync(
      `claude -p "$(cat ${tempFile})" --model ${model} --max-tokens ${maxTokens} --output-format text 2>/dev/null`,
      {
        encoding: 'utf8',
        timeout,
        maxBuffer: 1024 * 1024
      }
    );

    // Cleanup temp file
    try { fs.unlinkSync(tempFile); } catch {}

    return result.trim();
  } catch (error) {
    return null;
  }
}

/**
 * Compress content using LLM summarization (Phase B)
 * Falls back to heuristic compression if CLI unavailable
 */
function compressContentWithLLM(content, options = {}) {
  const { summaryRatio = DEFAULT_CONFIG.summaryRatio, preserveLines = 5, useLLM = true } = options;
  const lines = content.split('\n');
  const totalLines = lines.length;

  // Short content: return as-is
  if (totalLines <= preserveLines * 2 + 10) {
    return content;
  }

  // Check if LLM is available
  if (!useLLM || !isClaudeCliAvailable()) {
    return compressContent(content, options);
  }

  const header = lines.slice(0, preserveLines);
  const footer = lines.slice(-preserveLines);
  const middle = lines.slice(preserveLines, -preserveLines).join('\n');

  // Calculate target summary length
  const targetLength = Math.floor(middle.length * summaryRatio);

  // Build summarization prompt
  const summaryPrompt = `다음 텍스트를 ${targetLength}자 이내로 요약하세요.
핵심 정보만 불릿 포인트로 추출하세요. 마크다운 형식으로 응답하세요.

---
${middle}
---

요약:`;

  const summary = callClaudeCli(summaryPrompt, {
    model: 'haiku',
    maxTokens: Math.max(500, Math.floor(targetLength / 2))
  });

  if (!summary) {
    // Fallback to heuristic compression
    return compressContent(content, options);
  }

  return [...header, '\n## 📋 LLM Compressed Summary\n', summary, '\n', ...footer].join('\n');
}

/**
 * Extract heavy-hitters using LLM scoring (Phase B)
 * Falls back to heuristic extraction if CLI unavailable
 */
function extractHeavyHittersWithLLM(content, options = {}) {
  const { maxCount = 10, useLLM = true } = options;

  // Check if LLM is available
  if (!useLLM || !isClaudeCliAvailable()) {
    return extractHeavyHitters(content, options);
  }

  // For very short content, use heuristic
  if (content.length < 500) {
    return extractHeavyHitters(content, options);
  }

  const extractPrompt = `다음 텍스트에서 가장 중요한 ${maxCount}개의 핵심 문장/정보를 추출하세요.
각 항목을 JSON 배열로 반환하세요. 형식: [{"content": "문장", "reason": "중요한 이유"}]

---
${content.slice(0, 8000)}
---

JSON 응답:`;

  const response = callClaudeCli(extractPrompt, {
    model: 'haiku',
    maxTokens: 2000
  });

  if (!response) {
    return extractHeavyHitters(content, options);
  }

  try {
    // Parse JSON from response
    const jsonMatch = response.match(/\[[\s\S]*\]/);
    if (!jsonMatch) {
      return extractHeavyHitters(content, options);
    }

    const parsed = JSON.parse(jsonMatch[0]);
    const heavyHitters = parsed.slice(0, maxCount).map((item, idx) => ({
      type: 'llm-extracted',
      priority: idx + 1,
      content: item.content,
      reason: item.reason
    }));

    return {
      heavyHitters,
      totalCount: heavyHitters.length,
      compressionRatio: heavyHitters.length / content.split('\n').length,
      method: 'llm'
    };
  } catch {
    return extractHeavyHitters(content, options);
  }
}

/**
 * Build optimized prompt with H2O pattern
 */
function buildPrompt(contexts, prompt, options = {}) {
  const structured = structureContext(contexts, options);

  let result = `# 🔥 Heavy-Hitters (Critical Context)\n\n`;

  for (const ctx of structured) {
    result += `## From: ${ctx.source}\n\n`;
    for (const hitter of ctx.heavyHitters) {
      result += `${hitter.content}\n`;
    }
    result += '\n';
  }

  result += `# 📋 Compressed Context\n\n`;
  for (const ctx of structured) {
    result += `## ${ctx.source} (${ctx.type})\n\n`;
    result += `${ctx.summary}\n\n`;
  }

  result += `# ❓ Request\n\n${prompt}`;

  return result;
}

// ============================================
// RAG Hybrid Pipeline
// ============================================

/**
 * RAG Hybrid: Retrieve → Prioritize → Compress → Synthesize
 */
function ragHybridPipeline(query, documents, options = {}) {
  // 1. Retrieve (filter relevant documents)
  const relevant = retrieveDocuments(query, documents, options);

  // 2. Prioritize (sort by relevance/importance)
  const prioritized = prioritizeDocuments(relevant, query);

  // 3. Compress (apply compressive context)
  const compressed = prioritized.map(doc => ({
    ...doc,
    content: compressContent(doc.content, options)
  }));

  // 4. Synthesize (build final context)
  return buildPrompt(compressed, query, options);
}

/**
 * Retrieve relevant documents by keyword matching
 */
function retrieveDocuments(query, documents, options = {}) {
  const { threshold = 0.1 } = options;
  const keywords = query.toLowerCase().split(/\s+/).filter(w => w.length > 3);

  return documents
    .map(doc => {
      const content = (doc.content || '').toLowerCase();
      const matches = keywords.filter(kw => content.includes(kw)).length;
      const relevance = keywords.length > 0 ? matches / keywords.length : 0;
      return { ...doc, relevance, matchCount: matches };
    })
    .filter(doc => doc.relevance >= threshold)
    .sort((a, b) => b.relevance - a.relevance);
}

/**
 * Prioritize documents by combined score
 */
function prioritizeDocuments(documents, query) {
  return documents.map(doc => ({
    ...doc,
    priority: calculatePriority(doc, query)
  })).sort((a, b) => b.priority - a.priority);
}

/**
 * Calculate document priority score
 */
function calculatePriority(doc, _query) {
  let score = 0;

  // Relevance from retrieval
  score += (doc.relevance || 0) * 50;

  // Freshness bonus (recent content)
  if (doc.timestamp) {
    const age = Date.now() - new Date(doc.timestamp).getTime();
    score += Math.max(0, 20 - age / (1000 * 60 * 60 * 24)); // Decay over 20 days
  }

  // Type bonus
  const typeBonus = { 'code': 10, 'spec': 15, 'api': 12, 'doc': 8 };
  score += typeBonus[doc.type] || 5;

  return score;
}

// ============================================
// CLI Interface
// ============================================

function parseArgs() {
  const args = process.argv.slice(2);
  const options = { _: [] };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) {
      options._.push(a);
      continue;
    }

    const [key, value] = a.split('=', 2);
    const optionKey = key.slice(2);
    options[optionKey] = value !== undefined ? value : true;
  }

  return options;
}

/**
 * Map CLI options to function parameter names and convert types
 */
function normalizeOptions(options) {
  const normalized = { ...options };

  // Map CLI option names to function parameter names
  if (options['heavy-count'] !== undefined) {
    normalized.maxCount = Number(options['heavy-count']);
  }
  if (options['summary-ratio'] !== undefined) {
    normalized.summaryRatio = Number(options['summary-ratio']);
  }
  if (options['max-tokens'] !== undefined) {
    normalized.maxTokens = Number(options['max-tokens']);
  }
  if (options['preserve-lines'] !== undefined) {
    normalized.preserveLines = Number(options['preserve-lines']);
  }

  return normalized;
}

function printHelp() {
  console.log(`
Context Optimizer - Long Context Optimization Service

Usage:
  contextOptimizer.js optimize <file> [options]
  contextOptimizer.js compress <file> [options]
  contextOptimizer.js build <query> <file...> [options]

Options:
  --max-tokens=N       Target token limit (default: 8000)
  --heavy-count=N      Number of heavy hitters (default: 10)
  --summary-ratio=N    Compression ratio 0-1 (default: 0.3)
  --json               Output JSON format
  --llm                Use LLM-based extraction/compression (requires claude CLI)

Examples:
  # Optimize single file (heuristic)

  # Optimize with LLM scoring

  # Compress content (heuristic)
  contextOptimizer.js compress large-file.md

  # Compress with LLM summarization
  contextOptimizer.js compress large-file.md --llm --summary-ratio=0.3

  # Build RAG hybrid query
  contextOptimizer.js build "summarize this" docs/*.md
`);
}

function cmdOptimize(options) {
  const filePath = options._[1];
  if (!filePath) {
    console.error('Error: Missing file path');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const opts = normalizeOptions(options);
  opts.useLLM = options.llm === true;

  // Use LLM or heuristic extraction
  const extractFn = opts.useLLM ? extractHeavyHittersWithLLM : extractHeavyHitters;
  const result = extractFn(content, opts);

  if (options.json) {
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  const method = result.method === 'llm' ? '(LLM)' : '(Heuristic)';
  console.log(`# Heavy-Hitters from: ${filePath} ${method}\n`);
  console.log(`Extracted: ${result.heavyHitters.length} / ${result.totalCount} total\n`);
  for (const hitter of result.heavyHitters) {
    const extra = hitter.reason ? ` - ${hitter.reason}` : '';
    console.log(`[${hitter.type}] ${hitter.content}${extra}`);
  }
}

function cmdCompress(options) {
  const filePath = options._[1];
  if (!filePath) {
    console.error('Error: Missing file path');
    process.exit(1);
  }

  const content = fs.readFileSync(filePath, 'utf8');
  const opts = normalizeOptions(options);
  opts.useLLM = options.llm === true;

  // Use LLM or heuristic compression
  const compressFn = opts.useLLM ? compressContentWithLLM : compressContent;
  const compressed = compressFn(content, opts);

  if (options.json) {
    console.log(JSON.stringify({
      original: content.length,
      compressed: compressed.length,
      ratio: compressed.length / content.length,
      method: opts.useLLM ? 'llm' : 'heuristic'
    }, null, 2));
    return;
  }

  console.log(compressed);
}

function cmdBuild(options) {
  const query = options._[1];
  const files = options._.slice(2);

  if (!query) {
    console.error('Error: Missing query');
    process.exit(1);
  }

  const documents = files.map(file => ({
    source: file,
    type: path.extname(file).slice(1) || 'unknown',
    content: fs.readFileSync(file, 'utf8')
  }));

  const opts = normalizeOptions(options);
  const result = ragHybridPipeline(query, documents, opts);
  console.log(result);
}

function main() {
  const options = parseArgs();
  const [command] = options._;

  if (!command || options.help || options.h) {
    printHelp();
    return;
  }

  switch (command) {
    case 'optimize':
      cmdOptimize(options);
      break;
    case 'compress':
      cmdCompress(options);
      break;
    case 'build':
      cmdBuild(options);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

// ============================================
// Module Exports (for require/import)
// ============================================

module.exports = {
  // Heuristic functions (Phase A)
  extractHeavyHitters,
  structureContext,
  compressContent,
  buildPrompt,
  ragHybridPipeline,
  retrieveDocuments,
  prioritizeDocuments,
  // LLM-based functions (Phase B)
  extractHeavyHittersWithLLM,
  compressContentWithLLM,
  isClaudeCliAvailable,
  callClaudeCli,
  // Config
  DEFAULT_CONFIG,
  PRIORITY_SCORES,
  IMPORTANT_KEYWORDS
};

if (require.main === module) {
  main();
}
