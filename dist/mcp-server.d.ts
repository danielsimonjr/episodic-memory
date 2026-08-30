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
export {};
