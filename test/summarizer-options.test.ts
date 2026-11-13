import { describe, it, expect, afterEach } from 'vitest';
import {
  buildCodexSummaryPrompt,
  buildCodexSummarizerCommand,
  buildSummarizerQueryOptions,
  getApiEnv,
  getCodexModel,
  resolveLearnModels,
  runCodexCommand,
  shouldSkipReentrantSync
} from '../src/summarizer.js';

describe('resolveLearnModels', () => {
  it('defaults both the learn model and its fallback to sonnet', () => {
    expect(resolveLearnModels({})).toEqual({ model: 'sonnet', fallbackModel: 'sonnet' });
  });

  it('reads EPISODIC_MEMORY_LEARN_MODEL and EPISODIC_MEMORY_API_MODEL_FALLBACK', () => {
    expect(
      resolveLearnModels({
        EPISODIC_MEMORY_LEARN_MODEL: 'opus',
        EPISODIC_MEMORY_API_MODEL_FALLBACK: 'haiku',
      })
    ).toEqual({ model: 'opus', fallbackModel: 'haiku' });
  });

  it('falls back per key when one variable is empty and never reads the digest model', () => {
    expect(
      resolveLearnModels({
        EPISODIC_MEMORY_LEARN_MODEL: '   ',
        EPISODIC_MEMORY_API_MODEL: 'haiku',
      })
    ).toEqual({ model: 'sonnet', fallbackModel: 'sonnet' });
  });

  it('reads process.env by default', () => {
    process.env.EPISODIC_MEMORY_LEARN_MODEL = 'opus-test';
    try {
      expect(resolveLearnModels().model).toBe('opus-test');
    } finally {
      delete process.env.EPISODIC_MEMORY_LEARN_MODEL;
    }
  });
});

describe('buildSummarizerQueryOptions', () => {
  it('sets persistSession: false so the SDK does not write session JSONLs to ~/.claude/projects/ (#83)', () => {
    const opts = buildSummarizerQueryOptions({ model: 'haiku' });
    expect(opts.persistSession).toBe(false);
  });

  it('passes through the model and max_tokens', () => {
    const opts = buildSummarizerQueryOptions({ model: 'haiku' });
    expect(opts.model).toBe('haiku');
    expect(opts.max_tokens).toBe(4096);
  });

  it('includes a systemPrompt', () => {
    const opts = buildSummarizerQueryOptions({ model: 'haiku' });
    expect(opts.systemPrompt).toBeDefined();
  });

  it('runs in isolation: settingSources [] so the SDK subprocess does not load the user settings that boot every MCP server and fire SessionStart hooks (the process cascade)', () => {
    const opts = buildSummarizerQueryOptions({ model: 'haiku' });
    expect(opts.settingSources).toEqual([]);
  });

  it('exposes no MCP servers to the summarizer subprocess', () => {
    const opts = buildSummarizerQueryOptions({ model: 'haiku' });
    expect(opts.mcpServers).toEqual({});
  });

  it('names no executable unless the caller passes one, so the SDK runs the bundled binary', () => {
    expect('pathToClaudeCodeExecutable' in buildSummarizerQueryOptions({ model: 'haiku' })).toBe(false);
    expect('pathToClaudeCodeExecutable' in buildSummarizerQueryOptions({ model: 'haiku', executable: {} })).toBe(false);
    const opts = buildSummarizerQueryOptions({ model: 'haiku', executable: { pathToClaudeCodeExecutable: '/opt/claude' } });
    expect(opts.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(opts.model).toBe('haiku');
  });

  it('passes the learn model through unchanged, alongside the digest model', () => {
    const learn = resolveLearnModels({
      EPISODIC_MEMORY_LEARN_MODEL: 'opus',
      EPISODIC_MEMORY_API_MODEL: 'haiku',
    });
    expect(buildSummarizerQueryOptions({ model: learn.model }).model).toBe('opus');
    // The digest path keeps its own model; the learn setting never reaches it.
    expect(buildSummarizerQueryOptions({ model: 'haiku' }).model).toBe('haiku');
  });
});

describe('callLearnModel', () => {
  it('routes to the ollama backend when that backend is selected', async () => {
    // No model name is set, so the ollama call fails before any network I/O; the
    // error proves the request went to callOllama rather than the Claude path
    // (the Claude path would spawn the SDK instead of rejecting like this).
    const { callLearnModel } = await import('../src/summarizer.js');
    const saved = process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    try {
      await expect(callLearnModel('hello')).rejects.toThrow(/EPISODIC_MEMORY_OLLAMA_MODEL/);
    } finally {
      if (saved === undefined) delete process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND;
      else process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = saved;
    }
  });
});

describe('buildCodexSummarizerCommand', () => {
  it('starts the Codex app-server so the summarizer can fork ephemerally', () => {
    const command = buildCodexSummarizerCommand({
      sessionId: '019e4c75-d5bf-7c71-9df7-77f5fb86b711',
      model: 'gpt-5.2',
      prompt: 'Summarize this conversation.',
      codexBin: 'codex'
    });

    expect(command).toEqual({
      command: 'codex',
      args: ['app-server'],
      prompt: 'Summarize this conversation.',
      sessionId: '019e4c75-d5bf-7c71-9df7-77f5fb86b711',
      model: 'gpt-5.2'
    });
  });
});

describe('getCodexModel', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_CODEX_MODEL;
  });

  it('returns undefined when EPISODIC_MEMORY_CODEX_MODEL is unset, so the fork uses the Codex configuration model', () => {
    // setup-env deletes the machine value of the variable before each test file.
    expect(process.env.EPISODIC_MEMORY_CODEX_MODEL).toBeUndefined();
    expect(getCodexModel()).toBeUndefined();
  });

  it('returns the value of EPISODIC_MEMORY_CODEX_MODEL', () => {
    process.env.EPISODIC_MEMORY_CODEX_MODEL = 'gpt-5.5';
    expect(getCodexModel()).toBe('gpt-5.5');
  });

  it('treats an empty EPISODIC_MEMORY_CODEX_MODEL as unset', () => {
    process.env.EPISODIC_MEMORY_CODEX_MODEL = '';
    expect(getCodexModel()).toBeUndefined();
  });

  it('takes no conversation argument, so a history model such as gpt-5.2-codex cannot reach the fork', () => {
    expect(getCodexModel.length).toBe(0);
  });
});

describe('runCodexCommand', () => {
  it('forks the session ephemerally and returns the completed agent message', async () => {
    const fakeAppServer = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake', codexHome: '/tmp/codex', platformFamily: 'unix', platformOs: 'macos' } }));
          return;
        }
        if (message.method === 'initialized') return;
        if (message.method === 'thread/fork') {
          if (message.params.threadId !== 'session-123') throw new Error('wrong session id');
          if (message.params.ephemeral !== true) throw new Error('fork was not ephemeral');
          if (message.params.sandbox !== 'read-only') throw new Error('fork was not read-only');
          if (message.params.excludeTurns !== true) throw new Error('fork did not set excludeTurns (required by codex-cli 0.150+ for paginated threads)');
          console.log(JSON.stringify({ id: message.id, result: { thread: { id: 'fork-456' } } }));
          return;
        }
        if (message.method === 'turn/start') {
          if (message.params.threadId !== 'fork-456') throw new Error('turn did not target fork');
          if (!message.params.input[0].text.includes('Summarize this conversation')) throw new Error('wrong prompt');
          console.log(JSON.stringify({ id: message.id, result: { turn: { id: 'turn-789', status: 'inProgress' } } }));
          console.log(JSON.stringify({ method: 'item/agentMessage/delta', params: { delta: '<summary>Codex fork summary.</summary>' } }));
          console.log(JSON.stringify({ method: 'turn/completed', params: { turn: { id: 'turn-789', status: 'completed' } } }));
        }
      });
    `;

    const result = await runCodexCommand({
      command: process.execPath,
      args: ['-e', fakeAppServer],
      sessionId: 'session-123',
      prompt: 'Summarize this conversation.',
      skipVersionCheck: true,
    });

    expect(result).toBe('<summary>Codex fork summary.</summary>');
  });

  it('rejects Codex versions below the production support floor before starting app-server', async () => {
    await expect(runCodexCommand({
      command: process.execPath,
      versionArgs: ['-e', "console.log('codex-cli 0.129.9')"],
      args: ['-e', 'setTimeout(() => {}, 1000)'],
      sessionId: 'session-123',
      prompt: 'Summarize this conversation.',
    })).rejects.toThrow(/requires codex-cli >= 0\.130\.0; found 0\.129\.9/);
  });

  it('times out the codex --version probe instead of hanging when the binary stalls (F7)', async () => {
    // readCommandOutput previously had no timeout: a wedged `codex --version`
    // hung the whole summary loop. The probe must abort and reject.
    process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS = '150';
    try {
      await expect(runCodexCommand({
        command: process.execPath,
        versionArgs: ['-e', 'setTimeout(() => {}, 100000)'], // never prints, never exits
        args: ['-e', 'setTimeout(() => {}, 100000)'],
        sessionId: 'session-123',
        prompt: 'Summarize this conversation.',
      })).rejects.toThrow(/timed out/i);
    } finally {
      delete process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS;
    }
  });

  it('rejects cleanly (no hang) when the app-server exits right after initialize (F8)', async () => {
    // A premature child exit must settle the call via a clear error rather than
    // leaving in-flight send() promises dangling forever.
    const fakeAppServer = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          console.log(JSON.stringify({ id: message.id, result: { userAgent: 'fake' } }));
          process.exit(0); // die before answering thread/fork
        }
      });
    `;
    await expect(runCodexCommand({
      command: process.execPath,
      args: ['-e', fakeAppServer],
      sessionId: 'session-123',
      prompt: 'Summarize this conversation.',
      skipVersionCheck: true,
    })).rejects.toThrow(/exited before|exit code|stream closed/i);
  });

  it('reports malformed app-server fork responses clearly', async () => {
    const fakeAppServer = `
      const readline = require('readline');
      const rl = readline.createInterface({ input: process.stdin });
      rl.on('line', line => {
        const message = JSON.parse(line);
        if (message.method === 'initialize') {
          console.log(JSON.stringify({ id: message.id, result: {} }));
          return;
        }
        if (message.method === 'initialized') return;
        if (message.method === 'thread/fork') {
          console.log(JSON.stringify({ id: message.id, result: {} }));
        }
      });
    `;

    await expect(runCodexCommand({
      command: process.execPath,
      args: ['-e', fakeAppServer],
      sessionId: 'session-123',
      prompt: 'Summarize this conversation.',
      skipVersionCheck: true,
    })).rejects.toThrow(/thread\/fork returned unexpected response/);
  });
});

describe('buildCodexSummaryPrompt', () => {
  it('instructs Codex to summarize from forked session context without inspecting files', () => {
    const prompt = buildCodexSummaryPrompt();

    expect(prompt).toContain('ephemeral Codex fork');
    expect(prompt).toContain('reasoning');
    expect(prompt).toContain('Do not inspect files');
    expect(prompt).toContain('<summary>');
  });
});

describe('getApiEnv', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_API_BASE_URL;
    delete process.env.EPISODIC_MEMORY_API_TOKEN;
    delete process.env.EPISODIC_MEMORY_API_TIMEOUT_MS;
  });

  it('always sets EPISODIC_MEMORY_SUMMARIZER_GUARD so the SDK subprocess can detect reentrancy (#87)', () => {
    const env = getApiEnv()!;
    expect(env.EPISODIC_MEMORY_SUMMARIZER_GUARD).toBe('1');
  });

  it('routes ANTHROPIC_BASE_URL through to the SDK env when EPISODIC_MEMORY_API_BASE_URL is set', () => {
    process.env.EPISODIC_MEMORY_API_BASE_URL = 'https://example.invalid';
    const env = getApiEnv()!;
    expect(env.ANTHROPIC_BASE_URL).toBe('https://example.invalid');
  });

  it('routes auth token and timeout through to the SDK env', () => {
    process.env.EPISODIC_MEMORY_API_TOKEN = 'tok-test';
    process.env.EPISODIC_MEMORY_API_TIMEOUT_MS = '12345';
    const env = getApiEnv()!;
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('tok-test');
    expect(env.API_TIMEOUT_MS).toBe('12345');
  });
});

describe('shouldSkipReentrantSync', () => {
  afterEach(() => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD;
  });

  it('returns true when EPISODIC_MEMORY_SUMMARIZER_GUARD is set to "1"', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD = '1';
    expect(shouldSkipReentrantSync()).toBe(true);
  });

  it('returns false when the guard env is unset', () => {
    delete process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD;
    expect(shouldSkipReentrantSync()).toBe(false);
  });

  it('returns false when the guard env is set to anything other than "1"', () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD = '0';
    expect(shouldSkipReentrantSync()).toBe(false);
    process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD = 'true';
    expect(shouldSkipReentrantSync()).toBe(false);
  });
});
