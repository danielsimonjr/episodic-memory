#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory.
 *
 * This server provides tools to search and explore indexed Claude Code and Codex conversations
 * using semantic search, text search, and conversation display capabilities.
 *
 * Heavy modules (search / embeddings / show) are loaded lazily inside tool handlers so
 * ListTools / handshake stay cheap. Tool dispatch lives in mcp-tools.ts.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { VERSION } from './version.js';
import { closeSharedReaderDatabase } from './db.js';
import { handleToolCall } from './mcp-tools.js';

const server = new Server(
  {
    name: 'episodic-memory',
    version: VERSION,
  },
  {
    capabilities: {
      tools: {},
    }
  }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: 'search',
        description: `Gives you memory across sessions. You don't automatically remember past Claude Code and Codex conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for semantic search or array of 2-5 concepts for precise AND matching. Returns ranked results with project, date, snippets, summaries, and file paths.`,
        inputSchema: {
          type: 'object',
          properties: {
            query: {
              oneOf: [
                { type: 'string', minLength: 2 },
                { type: 'array', items: { type: 'string', minLength: 2 }, minItems: 2, maxItems: 5 },
              ],
            },
            mode: { type: 'string', enum: ['vector', 'text', 'both'], default: 'both' },
            limit: { type: 'number', minimum: 1, maximum: 50, default: 10 },
            after: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            before: { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' },
            project: { type: 'string', minLength: 1, description: 'Filter by project name (exact match)' },
            session_id: { type: 'string', minLength: 1, description: 'Filter by session ID (exact match)' },
            git_branch: { type: 'string', minLength: 1, description: 'Filter by git branch name (exact match)' },
            response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' },
            auth_token: { type: 'string', minLength: 1, description: 'Required when EPISODIC_MEMORY_MCP_TOKEN is set' },
          },
          required: ['query'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Search Episodic Memory',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'read',
        description: `Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
        inputSchema: {
          type: 'object',
          properties: {
            path: { type: 'string', minLength: 1 },
            startLine: { type: 'number', minimum: 1 },
            endLine: { type: 'number', minimum: 1 },
            auth_token: { type: 'string', minLength: 1, description: 'Required when EPISODIC_MEMORY_MCP_TOKEN is set' },
          },
          required: ['path'],
          additionalProperties: false,
        },
        annotations: {
          title: 'Read Full Conversation',
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
  };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const result = await handleToolCall(name, args);
  return {
    content: result.content,
    ...(result.isError ? { isError: true } : {}),
  };
});

async function main() {
  console.error('Episodic Memory MCP server running via stdio');

  const transport = new StdioServerTransport();
  await server.connect(transport);

  const cleanup = () => {
    closeSharedReaderDatabase();
  };
  process.on('exit', cleanup);
  process.on('SIGINT', () => {
    cleanup();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    cleanup();
    process.exit(0);
  });
}

main().catch((error) => {
  console.error('Server error:', error);
  process.exit(1);
});
