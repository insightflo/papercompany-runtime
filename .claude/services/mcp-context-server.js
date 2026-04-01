#!/usr/bin/env node

/**
 * MCP Server for Context Compression
 *
 * Provides tools for LLM context optimization using H2O and
 * Compressive Context patterns.
 *
 * Tools:
 * - compress_context: Compress long context using H2O pattern
 * - extract_heavy_hitters: Extract key insights from content
 * - build_optimized_prompt: Build optimized prompt with heavy hitters at top
 */

const { extractHeavyHitters, compressContent, buildPrompt } = require('./contextOptimizer.js');

// ============================================
// MCP Tool Handlers
// ============================================

/**
 * Tool: compress_context
 * Compress long context using H2O pattern
 */
async function handleCompressContext(args) {
  const { content, options = {} } = args;

  if (!content) {
    throw new Error('Missing required parameter: content');
  }

  const compressed = compressContent(content, {
    summaryRatio: options.summaryRatio || 0.3,
    preserveLines: options.preserveLines || 5
  });

  return {
    originalLength: content.length,
    compressedLength: compressed.length,
    compressionRatio: compressed.length / content.length,
    compressed
  };
}

/**
 * Tool: extract_heavy_hitters
 * Extract heavy-hitter tokens from content
 */
async function handleExtractHeavyHitters(args) {
  const { content, options = {} } = args;

  if (!content) {
    throw new Error('Missing required parameter: content');
  }

  const result = extractHeavyHitters(content, {
    maxCount: options.maxCount || 10
  });

  return {
    heavyHitters: result.heavyHitters,
    totalCount: result.totalCount,
    compressionRatio: result.compressionRatio
  };
}

/**
 * Tool: build_optimized_prompt
 * Build optimized prompt with heavy hitters at top
 */
async function handleBuildOptimizedPrompt(args) {
  const { contexts, query, options = {} } = args;

  if (!contexts || !Array.isArray(contexts)) {
    throw new Error('Missing required parameter: contexts (array)');
  }

  if (!query) {
    throw new Error('Missing required parameter: query');
  }

  const optimized = buildPrompt(contexts, query, options);

  return {
    originalLength: JSON.stringify(contexts).length + query.length,
    optimizedLength: optimized.length,
    optimized
  };
}

// ============================================
// MCP Server Implementation (stdio)
// ============================================

async function runServer() {
  const stdin = process.stdin;
  const stdout = process.stdout;
  const stderr = process.stderr;

  let buffer = '';

  stdin.setEncoding('utf8');

  for await (const chunk of stdin) {
    buffer += chunk;

    // Process complete JSON-RPC messages
    let newlineIndex;
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);

      if (!line.trim()) continue;

      try {
        const request = JSON.parse(line);
        const response = await handleRequest(request);
        stdout.write(JSON.stringify(response) + '\n');
      } catch (error) {
        const errorResponse = {
          jsonrpc: '2.0',
          id: null,
          error: {
            code: -32600,
            message: error.message
          }
        };
        stdout.write(JSON.stringify(errorResponse) + '\n');
      }
    }
  }
}

async function handleRequest(request) {
  const { jsonrpc, id, method, params } = request;

  if (jsonrpc !== '2.0') {
    throw new Error('Invalid JSON-RPC version');
  }

  let result;
  switch (method) {
    case 'tools/list':
      result = {
        tools: [
          {
            name: 'compress_context',
            description: 'Compress long context using H2O pattern',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Content to compress' },
                options: {
                  type: 'object',
                  properties: {
                    summaryRatio: { type: 'number', description: 'Compression ratio 0-1' },
                    preserveLines: { type: 'number', description: 'Lines to preserve at boundaries' }
                  }
                }
              },
              required: ['content']
            }
          },
          {
            name: 'extract_heavy_hitters',
            description: 'Extract heavy-hitter tokens from content',
            inputSchema: {
              type: 'object',
              properties: {
                content: { type: 'string', description: 'Content to analyze' },
                options: {
                  type: 'object',
                  properties: {
                    maxCount: { type: 'number', description: 'Max hitters to extract' }
                  }
                }
              },
              required: ['content']
            }
          },
          {
            name: 'build_optimized_prompt',
            description: 'Build optimized prompt with heavy hitters at top',
            inputSchema: {
              type: 'object',
              properties: {
                contexts: {
                  type: 'array',
                  description: 'Array of context objects with source, type, content',
                  items: {
                    type: 'object',
                    properties: {
                      source: { type: 'string' },
                      type: { type: 'string' },
                      content: { type: 'string' }
                    }
                  }
                },
                query: { type: 'string', description: 'User query/prompt' },
                options: { type: 'object', description: 'Optimization options' }
              },
              required: ['contexts', 'query']
            }
          }
        ]
      };
      break;

    case 'tools/call':
      const { name, arguments: toolArgs } = params;
      switch (name) {
        case 'compress_context':
          result = await handleCompressContext(toolArgs);
          break;
        case 'extract_heavy_hitters':
          result = await handleExtractHeavyHitters(toolArgs);
          break;
        case 'build_optimized_prompt':
          result = await handleBuildOptimizedPrompt(toolArgs);
          break;
        default:
          throw new Error(`Unknown tool: ${name}`);
      }
      break;

    case 'initialize':
      result = {
        protocolVersion: '2024-11-05',
        capabilities: {
          tools: {}
        },
        serverInfo: {
          name: 'context-optimizer-mcp',
          version: '1.0.0'
        }
      };
      break;

    default:
      throw new Error(`Unknown method: ${method}`);
  }

  return {
    jsonrpc: '2.0',
    id,
    result
  };
}

// ============================================
// CLI Interface
// ============================================

function parseArgs() {
  const args = process.argv.slice(2);
  return args;
}

function printHelp() {
  console.log(`
MCP Context Optimizer Server

Usage:
  mcp-context-server.js serve          Run MCP server (stdio mode)
  mcp-context-server.js help           Show this help

MCP Client Configuration:
  Add to your MCP client config (e.g., claude_desktop_config.json):

  {
    "mcpServers": {
      "context-optimizer": {
        "command": "node",
        "args": ["/path/to/project-team/services/mcp-context-server.js", "serve"]
      }
    }
  }

Available Tools:
  - compress_context: Compress long context
  - extract_heavy_hitters: Extract key insights
  - build_optimized_prompt: Build optimized prompt
`);
}

function main() {
  const args = parseArgs();
  const [command] = args;

  if (!command || command === 'help' || command === '--help' || command === '-h') {
    printHelp();
    return;
  }

  if (command === 'serve') {
    runServer().catch(error => {
      console.error('Server error:', error);
      process.exit(1);
    });
    return;
  }

  console.error(`Unknown command: ${command}`);
  printHelp();
  process.exit(1);
}

if (require.main === module) {
  main();
}

module.exports = {
  handleCompressContext,
  handleExtractHeavyHitters,
  handleBuildOptimizedPrompt,
  runServer
};
