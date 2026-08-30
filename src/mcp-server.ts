#!/usr/bin/env node
/**
 * MCP Server for Episodic Memory.
 *
 * This server provides tools to search and explore indexed Claude Code and Codex conversations
 * using semantic search, text search, and conversation display capabilities.
 *
 * Heavy modules (search / embeddings / show) are loaded lazily inside tool handlers so
 * ListTools / handshake stay cheap. Tool dispatch lives in mcp-tools.ts.
 *
 * Uses @modelcontextprotocol/server v2 with serveStdio for MCP 2026-07-28 (stateless)
 * while still serving legacy initialize-based clients (2025-11-25 and earlier).
 */

import { McpServer } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { VERSION } from './version.js';
import { closeSharedReaderDatabase } from './db.js';
import { handleToolCall } from './mcp-tools.js';
import {
  SearchInputSchema,
  ShowConversationInputSchema,
} from './mcp-schemas.js';

function buildServer(): McpServer {
  const server = new McpServer(
    { name: 'episodic-memory', version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.registerTool(
    'search',
    {
      title: 'Search Episodic Memory',
      description: `Gives you memory across sessions. You don't automatically remember past Claude Code and Codex conversations - this tool restores context by searching them. Use BEFORE every task to recover decisions, solutions, and avoid reinventing work. Single string for semantic search or array of 2-5 concepts for precise AND matching. Returns ranked results with project, date, snippets, summaries, and file paths.`,
      inputSchema: SearchInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const result = await handleToolCall('search', args);
      return {
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    }
  );

  server.registerTool(
    'read',
    {
      title: 'Read Full Conversation',
      description: `Read full conversations to extract detailed context after finding relevant results with search. Essential for understanding the complete rationale, evolution, and gotchas behind past decisions. Use startLine/endLine pagination for large conversations to avoid context bloat (line numbers are 1-indexed).`,
      inputSchema: ShowConversationInputSchema,
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async (args) => {
      const result = await handleToolCall('read', args);
      return {
        content: result.content,
        ...(result.isError ? { isError: true } : {}),
      };
    }
  );

  return server;
}

console.error('Episodic Memory MCP server running via stdio');

const handle = serveStdio(() => buildServer());

const cleanup = () => {
  closeSharedReaderDatabase();
  void handle.close();
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
