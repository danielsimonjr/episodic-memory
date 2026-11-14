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
  lines: string[],
  envOverrides: Record<string, string | undefined> = {}
): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve, reject) => {
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      EPISODIC_MEMORY_CONFIG_DIR: process.env.EPISODIC_MEMORY_CONFIG_DIR ?? '/tmp/em-mcp-probe-config',
      ...envOverrides,
    };
    for (const key of Object.keys(env)) if (env[key] === undefined && key in envOverrides) delete env[key];
    const child = spawn(SERVER_CMD[0], SERVER_CMD.slice(1), {
      cwd: REPO_ROOT,
      stdio: ['pipe', 'pipe', 'pipe'],
      env,
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
    expect(toolNames).toEqual(['search', 'read', 'digest', 'skills', 'topics']);
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
    expect(toolNames).toEqual(['search', 'read', 'digest', 'skills', 'topics']);
  });

  /**
   * The spec's fast-path guarantee (§6.3, §7 rule 1): a session that never calls
   * `skills` never opens the knowledge store. The bundle marks
   * `./learn/skills-tool.js` external so it stays a real runtime import, and this
   * loader probe fails the process if that module is ever resolved. ListTools and
   * a search must still work; the `skills` call is then the one that trips the
   * probe — which is the proof that the load is lazy rather than merely late.
   */
  it('does not load skills-tool until the skills tool runs', async () => {
    const probe = 'file://' + join(REPO_ROOT, 'test/helpers/forbid-modules.mjs');
    const { stdout } = await sendLines(
      [
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
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'auth flow', mode: 'text' } },
        }),
        JSON.stringify({
          jsonrpc: '2.0',
          id: 4,
          method: 'tools/call',
          params: { name: 'skills', arguments: {} },
        }),
      ],
      {
        EPISODIC_MEMORY_LEARN: undefined,
        FORBID_MODULES: './learn/skills-tool.js',
        NODE_OPTIONS: `--import=${probe}`,
      }
    );

    const messages = parseStdoutLines(stdout);
    // Handshake and ListTools never touch the store.
    expect(messages.find((m) => m.id === 1)?.error).toBeUndefined();
    const tools = messages.find((m) => m.id === 2);
    const toolNames = (tools?.result as { tools: Array<{ name: string }> })?.tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'read', 'digest', 'skills', 'topics']);

    // A search must succeed under the probe: skills-tool is not on that path.
    const search = messages.find((m) => m.id === 3);
    const searchText = (search?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '';
    expect(searchText).not.toMatch(/forbidden module/);

    // Flag-off `skills` answers without importing skills-tool, so the store stays
    // unopened. The probe would have failed the call if the import ran.
    const skills = messages.find((m) => m.id === 4);
    const skillsText = (skills?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '';
    expect(skillsText).toMatch(/Learning is off/);
    expect(skillsText).not.toMatch(/forbidden module/);
  });

  /**
   * The bundle keeps `onnxruntime-node` and `@huggingface/tokenizers` external.
   * A static import of either package in `embeddings.ts` became a top-level import of the bundle.
   * Every server start therefore loaded the embedding runtime and its native binding (onnxruntime-node).
   * A host where a binding cannot load lost every tool.
   * The probe makes the packages fail to resolve. The handshake, ListTools and a text search must still work.
   */
  it('does not load the embedding runtime at start or for a text search', async () => {
    const probe = 'file://' + join(REPO_ROOT, 'test/helpers/forbid-modules.mjs');
    const { stdout } = await sendLines(
      [
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
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'search', arguments: { query: 'auth flow', mode: 'text' } },
        }),
      ],
      {
        FORBID_MODULES: 'onnxruntime-node,@huggingface/tokenizers',
        NODE_OPTIONS: `--import=${probe}`,
      }
    );

    const messages = parseStdoutLines(stdout);
    expect(messages.find((m) => m.id === 1)?.error).toBeUndefined();
    const tools = messages.find((m) => m.id === 2);
    const toolNames = (tools?.result as { tools: Array<{ name: string }> })?.tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'read', 'digest', 'skills', 'topics']);
    const search = messages.find((m) => m.id === 3);
    expect(search?.error).toBeUndefined();
    const searchText = (search?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '';
    expect(searchText).not.toMatch(/forbidden module/);
  });

  it('loads skills-tool on a flag-on skills call and not before', async () => {
    const probe = 'file://' + join(REPO_ROOT, 'test/helpers/forbid-modules.mjs');
    const { stdout } = await sendLines(
      [
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
        JSON.stringify({
          jsonrpc: '2.0',
          id: 3,
          method: 'tools/call',
          params: { name: 'skills', arguments: {} },
        }),
      ],
      {
        EPISODIC_MEMORY_LEARN: '1',
        FORBID_MODULES: './learn/skills-tool.js',
        NODE_OPTIONS: `--import=${probe}`,
      }
    );

    const messages = parseStdoutLines(stdout);
    const tools = messages.find((m) => m.id === 2);
    const toolNames = (tools?.result as { tools: Array<{ name: string }> })?.tools.map((t) => t.name);
    expect(toolNames).toEqual(['search', 'read', 'digest', 'skills', 'topics']);
    const skills = messages.find((m) => m.id === 3);
    const skillsText = (skills?.result as { content?: Array<{ text: string }> })?.content?.[0]?.text ?? '';
    expect(skillsText).toMatch(/forbidden module loaded: \.\/learn\/skills-tool\.js/);
  });

  it('keeps stdout to JSON-RPC only with the skills tool registered', async () => {
    const { stdout } = await sendLines([
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

    // Every non-empty stdout line parses as a JSON-RPC message.
    const lines = stdout.split('\n').filter((line) => line.trim());
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) {
      const parsed = JSON.parse(line) as JsonRpcMessage;
      expect(parsed.jsonrpc).toBe('2.0');
    }
  });
});
