import { describe, it, expect } from 'vitest';
import { spawn } from 'child_process';
import { join } from 'path';
import { fileURLToPath } from 'url';

const REPO_ROOT = join(fileURLToPath(new URL('.', import.meta.url)), '..');
const SERVER_CMD = ['node', join(REPO_ROOT, 'cli/mcp-server-wrapper.js')];

const PROTOCOL_VERSION_META_KEY = 'io.modelcontextprotocol/protocolVersion';
const CLIENT_INFO_META_KEY = 'io.modelcontextprotocol/clientInfo';
const CLIENT_CAPABILITIES_META_KEY = 'io.modelcontextprotocol/clientCapabilities';

function modernMeta() {
  return {
    [PROTOCOL_VERSION_META_KEY]: '2026-07-28',
    [CLIENT_INFO_META_KEY]: { name: 'probe', version: '0.0' },
    [CLIENT_CAPABILITIES_META_KEY]: {},
  };
}

interface JsonRpcMessage {
  jsonrpc: '2.0';
  id?: number;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function sendLines(
  lines: string[]
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const child = spawn(SERVER_CMD[0], SERVER_CMD.slice(1), {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        EPISODIC_MEMORY_CONFIG_DIR: process.env.EPISODIC_MEMORY_CONFIG_DIR ?? '/tmp/em-mcp-probe-config',
      },
    });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf-8');
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf-8');
    });
    child.on('error', reject);
    child.on('close', (exitCode) => resolve({ stdout, stderr, exitCode }));

    for (const line of lines) {
      child.stdin.write(line + '\n');
    }
    child.stdin.end();
  });
}

function parseStdoutLines(stdout: string): JsonRpcMessage[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as JsonRpcMessage);
}

describe('MCP protocol compliance', () => {
  it('answers legacy initialize with 2025-11-25 and lists tools', async () => {
    const { stdout, stderr } = await sendLines([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: '2025-11-25',
          capabilities: {},
          clientInfo: { name: 'probe', version: '0.0' },
        },
      }),
      JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }),
      JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }),
    ]);

    expect(stderr).toContain('Episodic Memory MCP server running via stdio');

    const messages = parseStdoutLines(stdout);
    const init = messages.find((m) => m.id === 1);
    expect(init?.result).toMatchObject({
      protocolVersion: '2025-11-25',
      serverInfo: { name: 'episodic-memory' },
      capabilities: { tools: {} },
    });

    const tools = messages.find((m) => m.id === 2);
    const toolNames = (tools?.result as { tools: Array<{ name: string }> })?.tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'read']);
  });

  it('answers server/discover for MCP 2026-07-28 with supported versions', async () => {
    const { stdout } = await sendLines([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: modernMeta(),
        },
      }),
    ]);

    const messages = parseStdoutLines(stdout);
    const discover = messages.find((m) => m.id === 1);
    expect(discover?.error).toBeUndefined();

    const result = discover?.result as {
      supportedVersions?: string[];
      capabilities?: { tools?: unknown };
      _meta?: Record<string, { name?: string }>;
    };
    expect(result?.supportedVersions).toContain('2026-07-28');
    expect(result?._meta?.['io.modelcontextprotocol/serverInfo']?.name).toBe('episodic-memory');
    expect(result?.capabilities?.tools).toBeDefined();
  });

  it('lists tools on a modern connection after server/discover', async () => {
    const { stdout } = await sendLines([
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'server/discover',
        params: {
          _meta: modernMeta(),
        },
      }),
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/list',
        params: {
          _meta: modernMeta(),
        },
      }),
    ]);

    const messages = parseStdoutLines(stdout);
    const tools = messages.find((m) => m.id === 2);
    const toolNames = (tools?.result as { tools: Array<{ name: string }> })?.tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'read']);
  });
});
