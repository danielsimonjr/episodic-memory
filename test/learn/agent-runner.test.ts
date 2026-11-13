import { describe, it, expect, afterEach, vi } from 'vitest';
import os from 'os';
import path from 'path';
import { CLAUDE_BIN_ENV, ClaudeBinError } from '../../src/claude-bin.js';
import {
  buildAgentQueryOptions,
  listAgentProcesses,
  runAgent,
  type ProcSnapshot,
} from '../../src/learn/agent-runner.js';
import {
  SERVED_TOOL_NAMES,
  PROPOSE_TOOL_NAME,
  buildLearnToolServer,
} from '../../src/learn/sdk-tools.js';
import { SUMMARIZER_GUARD_ENV } from '../../src/reentrancy.js';

type Options = Record<string, any>;

function optionsFor(over: Partial<Parameters<typeof buildAgentQueryOptions>[0]> = {}): Options {
  const server = buildLearnToolServer({
    project: 'proj-a',
    hideExchangeIds: [],
    allowPropose: false,
  });
  return buildAgentQueryOptions({
    server,
    allowPropose: false,
    maxTurns: 12,
    maxBudgetUsd: 0.25,
    model: 'sonnet',
    abortController: new AbortController(),
    systemPrompt: 'You are a solver.',
    ...over,
  });
}

describe('buildAgentQueryOptions', () => {
  const savedGuard = process.env[SUMMARIZER_GUARD_ENV];

  it('names no executable unless the caller passes one, so the SDK runs the bundled binary', () => {
    expect('pathToClaudeCodeExecutable' in optionsFor()).toBe(false);
    const opts = optionsFor({ executable: { pathToClaudeCodeExecutable: '/opt/claude' } });
    expect(opts.pathToClaudeCodeExecutable).toBe('/opt/claude');
    expect(opts.tools).toEqual([]);
  });

  afterEach(() => {
    if (savedGuard === undefined) delete process.env[SUMMARIZER_GUARD_ENV];
    else process.env[SUMMARIZER_GUARD_ENV] = savedGuard;
  });

  it('passes the model, turn cap and budget through', () => {
    const options = optionsFor();
    expect(options.model).toBe('sonnet');
    expect(options.maxTurns).toBe(12);
    expect(options.maxBudgetUsd).toBe(0.25);
  });

  it('gives the subprocess no built-in tools at all', () => {
    const options = optionsFor();
    expect(options.tools).toEqual([]);
  });

  it('names every built-in it must not reach in disallowedTools', () => {
    const options = optionsFor();
    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([
        'Bash',
        'Read',
        'Write',
        'Edit',
        'WebFetch',
        'WebSearch',
        'Agent',
        'Skill',
        'Glob',
        'Grep',
      ])
    );
  });

  it('isolates the process from every settings source and persists nothing', () => {
    const options = optionsFor();
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settingSources).toEqual([]);
    expect(options.persistSession).toBe(false);
  });

  it('registers only the in-process episodic-learn server', () => {
    const options = optionsFor();
    expect(Object.keys(options.mcpServers)).toEqual(['episodic-learn']);
    expect(options.mcpServers['episodic-learn'].name).toBe('episodic-learn');
    expect(options.mcpServers['episodic-learn'].type).toBe('sdk');
  });

  it('allows only the served wildcard', () => {
    const options = optionsFor();
    expect(options.allowedTools).toEqual(['mcp__episodic-learn__*']);
  });

  it('carries the summarizer guard in env', () => {
    const options = optionsFor();
    expect(options.env[SUMMARIZER_GUARD_ENV]).toBe('1');
  });

  it('uses a string system prompt', () => {
    const options = optionsFor();
    expect(typeof options.systemPrompt).toBe('string');
    expect(options.systemPrompt).toBe('You are a solver.');
  });

  it('carries the abort controller', () => {
    const controller = new AbortController();
    const options = optionsFor({ abortController: controller });
    expect(options.abortController).toBe(controller);
  });

  describe('canUseTool', () => {
    it('denies Bash and allows a served tool', async () => {
      const options = optionsFor();
      const canUseTool = options.canUseTool as (
        name: string,
        input: Record<string, unknown>,
        ctx: unknown
      ) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

      const denied = await canUseTool('Bash', { command: 'ls' }, {});
      expect(denied.behavior).toBe('deny');

      const allowed = await canUseTool(SERVED_TOOL_NAMES[0], {}, {});
      expect(allowed.behavior).toBe('allow');
    });

    it('denies propose_entry unless the agent may propose', async () => {
      const reader = optionsFor({ allowPropose: false });
      const learner = optionsFor({ allowPropose: true });

      const asReader = reader.canUseTool as (n: string) => Promise<{ behavior: string }>;
      const asLearner = learner.canUseTool as (n: string) => Promise<{ behavior: string }>;

      expect((await asReader(PROPOSE_TOOL_NAME)).behavior).toBe('deny');
      expect((await asLearner(PROPOSE_TOOL_NAME)).behavior).toBe('allow');
    });

    it('denies a same-named tool from another MCP server', async () => {
      const options = optionsFor();
      const canUseTool = options.canUseTool as (n: string) => Promise<{ behavior: string }>;
      expect((await canUseTool('mcp__github__search')).behavior).toBe('deny');
    });
  });
});

describe('runAgent', () => {
  it('is a function a caller can inject', () => {
    expect(typeof runAgent).toBe('function');
  });

  const baseOptions = {
    prompt: 'find it',
    systemPrompt: 'You are a solver.',
    allowPropose: false,
    maxTurns: 12,
    maxBudgetUsd: 0.5,
    timeoutMs: 5000,
    model: 'sonnet',
    processLister: () => [] as Array<{ pid: number; commandLine: string }>,
  };

  function server() {
    return buildLearnToolServer({ project: 'proj-a', hideExchangeIds: [], allowPropose: false });
  }

  /** A stream shaped like the SDK's: init, a tool call, its result, then a result. */
  function fakeStream(): AsyncIterable<any> {
    return (async function* () {
      yield { type: 'system', subtype: 'init', tools: [...SERVED_TOOL_NAMES] };
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'tu-1',
              name: 'mcp__episodic-learn__search',
              input: { query: 'cache' },
            },
          ],
        },
      };
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu-1',
              content: 'Found 1 conversation\npath: /archive/proj/s1.jsonl\nSome long result text.',
            },
          ],
        },
      };
      yield {
        type: 'result',
        subtype: 'success',
        is_error: false,
        result: 'path: /archive/proj/s1.jsonl\nlines: 3-9\nproject: proj-a',
        num_turns: 4,
        total_cost_usd: 0.03,
        usage: { input_tokens: 100, output_tokens: 40, cache_read_input_tokens: 10 },
      };
    })();
  }

  it('records a trace of addresses without the result text', async () => {
    const result = await runAgent({
      ...baseOptions,
      server: server(),
      queryFn: () => fakeStream(),
    });

    expect(result.outcome).toBe('graded');
    expect(result.trace).toHaveLength(1);
    expect(result.trace[0].tool).toBe('mcp__episodic-learn__search');
    expect(result.trace[0].args).toEqual({ query: 'cache' });
    expect(result.trace[0].resultAddress).toBe('/archive/proj/s1.jsonl');
    expect(result.trace[0].resultChars).toBeGreaterThan(0);
    expect(JSON.stringify(result.trace)).not.toContain('Some long result text');
  });

  it('passes the executable option to the SDK, and a ClaudeBinError of the default stops the run before any call', async () => {
    const seen: Record<string, unknown>[] = [];
    await runAgent({
      ...baseOptions,
      server: server(),
      executable: { pathToClaudeCodeExecutable: '/opt/claude' },
      queryFn: params => {
        seen.push(params.options);
        return fakeStream();
      },
    });
    expect(seen[0].pathToClaudeCodeExecutable).toBe('/opt/claude');

    const missing = path.join(os.tmpdir(), 'em-agent-runner-missing', 'claude.exe');
    const saved = process.env[CLAUDE_BIN_ENV];
    process.env[CLAUDE_BIN_ENV] = missing;
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {});
    let calls = 0;
    try {
      await expect(
        runAgent({ ...baseOptions, server: server(), queryFn: () => { calls += 1; return fakeStream(); } })
      ).rejects.toBeInstanceOf(ClaudeBinError);
    } finally {
      quiet.mockRestore();
      if (saved === undefined) delete process.env[CLAUDE_BIN_ENV];
      else process.env[CLAUDE_BIN_ENV] = saved;
    }
    expect(calls).toBe(0);
  });

  it('reads the init tool list and the cost from the result', async () => {
    const result = await runAgent({ ...baseOptions, server: server(), queryFn: () => fakeStream() });
    expect(result.toolsSeen).toEqual([...SERVED_TOOL_NAMES]);
    expect(result.cost).toEqual({
      turns: 4,
      inputTokens: 110,
      outputTokens: 40,
      usd: 0.03,
    });
    expect(result.text).toContain('path: /archive/proj/s1.jsonl');
  });

  it('grades an error result as error', async () => {
    const result = await runAgent({
      ...baseOptions,
      server: server(),
      queryFn: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', tools: [] };
          yield { type: 'result', subtype: 'error_during_execution', is_error: true, result: 'boom', num_turns: 1 };
        })(),
    });
    expect(result.outcome).toBe('error');
  });

  it('records aborted when the timeout fires', async () => {
    const result = await runAgent({
      ...baseOptions,
      timeoutMs: 20,
      server: server(),
      queryFn: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', tools: [] };
          await new Promise(resolve => setTimeout(resolve, 200));
          yield { type: 'result', is_error: false, result: 'late' };
        })(),
    });
    expect(result.outcome).toBe('aborted');
    expect(result.text).toMatch(/timed out/i);
  });

  it('sees exactly the served tools, and nothing else', async () => {
    const result = await runAgent({ ...baseOptions, server: server(), queryFn: () => fakeStream() });
    // The init message reports the fully qualified names; compare as a set so
    // either CLI ordering passes, but a missing or extra tool never does.
    expect([...result.toolsSeen].sort()).toEqual([...SERVED_TOOL_NAMES].sort());
    expect(result.toolsSeen).not.toContain(PROPOSE_TOOL_NAME);
  });

  it('records killed when the subprocess dies by signal', async () => {
    const result = await runAgent({
      ...baseOptions,
      server: server(),
      queryFn: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', tools: [] };
          const error = new Error('process exited with SIGKILL') as Error & { signal?: string };
          error.signal = 'SIGKILL';
          throw error;
        })(),
    });
    expect(result.outcome).toBe('killed');
  });

  it('records error for any other failure', async () => {
    const result = await runAgent({
      ...baseOptions,
      server: server(),
      queryFn: () =>
        (async function* () {
          throw new Error('network fell over');
        })(),
    });
    expect(result.outcome).toBe('error');
    expect(result.text).toContain('network fell over');
  });

  it('registers the direct claude child of this process and its grandchildren', async () => {
    const added: number[] = [];
    const pids = { add: (pid: number) => added.push(pid), remove: () => {} };

    let call = 0;
    const processLister = () => {
      call += 1;
      if (call === 1) return [] as Array<{ pid: number; ppid?: number; commandLine: string }>;
      return [
        { pid: 500, ppid: process.pid, commandLine: 'claude -p --output-format stream-json' },
        { pid: 501, ppid: 500, commandLine: 'claude --bg-pty-host' },
        { pid: 9, ppid: 1, commandLine: 'claude --resume someone-elses-session' },
      ];
    };

    await runAgent({
      ...baseOptions,
      server: server(),
      pids,
      pollMs: 5,
      processLister,
      queryFn: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', tools: [] };
          await new Promise(resolve => setTimeout(resolve, 30));
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    });

    expect(added).toContain(500);
    expect(added).toContain(501);
    // Unrelated to this process and not an SDK plumbing shape: left alone.
    expect(added).not.toContain(9);
  });

  it('registers and releases the subprocess pids it saw', async () => {
    const added: number[] = [];
    const removed: number[] = [];
    const pids = { add: (pid: number) => added.push(pid), remove: (pid: number) => removed.push(pid) };

    let call = 0;
    const processLister = () => {
      call += 1;
      // The baseline poll sees only a pre-existing session; later polls see the
      // SDK's fork worker appear under our run.
      if (call === 1) return [{ pid: 1, commandLine: 'claude --resume mine' }];
      return [
        { pid: 1, commandLine: 'claude --resume mine' },
        { pid: 4242, commandLine: 'claude --fork-session --resume x' },
      ];
    };

    await runAgent({
      ...baseOptions,
      server: server(),
      pids,
      pollMs: 5,
      processLister,
      queryFn: () =>
        (async function* () {
          yield { type: 'system', subtype: 'init', tools: [] };
          await new Promise(resolve => setTimeout(resolve, 30));
          yield { type: 'result', is_error: false, result: 'done' };
        })(),
    });

    expect(added).toContain(4242);
    // The user's own session is never registered.
    expect(added).not.toContain(1);
    // Everything registered is released when the run ends.
    for (const pid of added) expect(removed).toContain(pid);
  });
  /** A stream that yields init, waits `ms`, then yields a result. */
  function slowStream(ms: number): () => AsyncIterable<any> {
    return () =>
      (async function* () {
        yield { type: 'system', subtype: 'init', tools: [] };
        await new Promise(resolve => setTimeout(resolve, ms));
        yield { type: 'result', is_error: false, result: 'done' };
      })();
  }

  it('lists no process when the run has no pid registry', async () => {
    let calls = 0;
    await runAgent({
      ...baseOptions,
      server: server(),
      pollMs: 5,
      processLister: () => {
        calls += 1;
        return [];
      },
      queryFn: slowStream(30),
    });
    expect(calls).toBe(0);
  });

  it('shares one listing across concurrent runs and never starts a listing while one is in flight', async () => {
    const pids = { add: () => {}, remove: () => {} };
    let calls = 0;
    let release: (() => void) | null = null;
    // The first call is the baseline. Every later call stays pending until the test releases it.
    const processLister = (): ProcSnapshot[] | Promise<ProcSnapshot[]> => {
      calls += 1;
      if (calls === 1) return [];
      return new Promise<ProcSnapshot[]>(resolve => {
        release = () => resolve([]);
      });
    };
    const run = () =>
      runAgent({ ...baseOptions, server: server(), pids, pollMs: 5, processLister, queryFn: slowStream(80) });

    await Promise.all([run(), run()]);

    // One baseline and one tick in flight, for both runs together.
    expect(calls).toBe(2);
    (release as (() => void) | null)?.();
  });

  it('contains a registry that throws, so a listing never raises an unhandled rejection', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      let calls = 0;
      const processLister = (): ProcSnapshot[] => {
        calls += 1;
        // The baseline sees nothing. Every later listing shows a direct child, so the tracker calls add.
        return calls === 1 ? [] : [{ pid: 701, ppid: process.pid, commandLine: 'claude -p' }];
      };
      const pids = {
        add: () => {
          throw new Error('registry write failed');
        },
        remove: () => {},
      };
      const result = await runAgent({
        ...baseOptions,
        server: server(),
        pids,
        pollMs: 5,
        processLister,
        queryFn: slowStream(40),
      });
      // Let a rejection from the last tick reach the process before the check.
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(calls).toBeGreaterThan(1);
      expect(result.outcome).toBe('graded');
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('keeps a live child registered when a concurrent run ends first', async () => {
    const live = new Set<number>();
    const pids = { add: (pid: number) => live.add(pid), remove: (pid: number) => live.delete(pid) };
    let spawned = false;
    const processLister = (): ProcSnapshot[] =>
      spawned ? [{ pid: 700, ppid: process.pid, commandLine: 'claude -p --output-format stream-json' }] : [];

    const long = runAgent({ ...baseOptions, server: server(), pids, pollMs: 5, processLister, queryFn: slowStream(160) });
    const short = runAgent({ ...baseOptions, server: server(), pids, pollMs: 5, processLister, queryFn: slowStream(50) });
    spawned = true;

    await short;
    // Both runs share this process as parent, so neither can tell whose child 700 is.
    // The child is still live, so it must stay in the registry while any run is live.
    expect(live.has(700)).toBe(true);

    await long;
    // The last run releases everything: an orphan of a finished run is the reaper's to take.
    expect(live.has(700)).toBe(false);
  });
});

describe('listAgentProcesses', () => {
  it('returns a promise, so a listing never blocks the event loop', async () => {
    const pending = listAgentProcesses();
    expect(pending).toBeInstanceOf(Promise);
    const procs = await pending;
    expect(procs === null || Array.isArray(procs)).toBe(true);
  }, 30000);
});
