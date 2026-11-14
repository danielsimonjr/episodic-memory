/**
 * Smoke test of the harness: the sandbox, the CLI, the seeded transcript, the MCP server and the
 * fake Ollama. Each case proves one part of the harness works before the cases rely on it.
 */
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { MCP_TOOLS } from './cases.js';
import {
  LISTER_PATH, PROMPT_HEADERS, REPO_ROOT, assertRepoPreconditions, buildEnv, classifyPrompt, cliBin, envViolations, fakeOllama, makeSandbox, McpClient,
  newSyncWorkers, openIndexDb, readHookLog, readSyncLog, removeSandbox, runCli, runHook, seedDigestableSession, seedTranscript,
  CLI_DIR, DIST_DIR, argvViolations, isRepoWorker, syncLockPath, syncWorkerPids, textOf, waitForBackgroundSync, waitUntil,
  type FakeOllama, type Sandbox,
} from './harness.js';
import { leakedSeedFiles, useIsolation } from './isolation.js';

/** A word that the fixture's user messages contain. The search must find it. */
const FIXTURE_WORD = 'baseline';
const PROJECT = 'e2e-smoke';

let sb: Sandbox;
let ollama: FakeOllama;

useIsolation();

beforeAll(async () => {
  assertRepoPreconditions();
  sb = makeSandbox();
  ollama = await fakeOllama('ok');
});

afterAll(async () => {
  if (ollama) await ollama.close();
  if (sb) removeSandbox(sb);
});

describe('e2e smoke: harness', () => {
  it('runs stats on an empty sandbox with exit 0', async () => {
    const result = await runCli(sb, cliBin('episodic-memory.js'), ['stats']);
    expect(result.code).toBe(0);
    expect(result.stdout.trim().length).toBeGreaterThan(0);
  });

  it('syncs a seeded transcript, indexes it, and finds it with search --text', async () => {
    seedTranscript(sb, PROJECT, 'short-conversation.jsonl');
    // `sync` copies the transcript into the archive. `index` reads only the archive, so the
    // copy must come first. SKIP_SUMMARIES keeps the model out of the smoke run.
    const sync = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } });
    expect(sync.code).toBe(0);
    const index = await runCli(sb, cliBin('episodic-memory.js'), ['index', '--no-summaries']);
    expect(index.code).toBe(0);
    const search = await runCli(sb, cliBin('episodic-memory.js'), ['search', '--text', FIXTURE_WORD]);
    expect(search.code).toBe(0);
    expect(search.stdout.toLowerCase()).toContain(FIXTURE_WORD);
  });

  it('starts the MCP server, lists its five tools, and answers one search', async () => {
    const client = await McpClient.start(sb);
    let closed: number | null = null;
    try {
      expect(await client.listTools()).toEqual(MCP_TOOLS);
      const result = await client.call('search', { query: FIXTURE_WORD });
      expect(result.isError).not.toBe(true);
      expect(textOf(result).toLowerCase()).toContain(FIXTURE_WORD);
    } finally {
      closed = await client.close();
    }
    expect(closed).toBe(0);
  });

  it('routes a child sync summary to the fake Ollama through the sandbox env', async () => {
    seedTranscript(sb, 'e2e-routing', 'short-conversation.jsonl');
    const before = ollama.requests.filter((r) => r.kind === 'summary').length;
    // No SKIP_SUMMARIES here: the child must reach the fake, which only the URL override allows.
    // The async runner: spawnSync would block the fake server, which runs in this process.
    const sync = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], { env: { EPISODIC_MEMORY_OLLAMA_URL: ollama.url } });
    expect(sync.code).toBe(0);
    expect(ollama.requests.filter((r) => r.kind === 'summary').length).toBeGreaterThan(before);
    // The reply must be USED, not only requested: the summary text must reach a product output.
    const shown = await runCli(sb, cliBin('episodic-memory.js'), ['search', '--text', FIXTURE_WORD]);
    expect(shown.stdout).toContain('E2E summary MARKER');
  });

  it('answers a summary request from the fake Ollama and records it', async () => {
    const before = ollama.requests.length;
    const response = await fetch(`${ollama.url}/api/generate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'e2e-fake',
        prompt: `${PROMPT_HEADERS.summary}

Use <summary></summary> tags.`,
        stream: false,
        think: false,
        options: { temperature: 0 },
      }),
    });
    const body = (await response.json()) as { response: string };
    expect(body.response).toContain('<summary>E2E summary MARKER</summary>');
    expect(ollama.requests.length).toBe(before + 1);
    expect(ollama.requests[before].kind).toBe('summary');
  });
});

describe('e2e smoke: detached-worker helpers', () => {
  it('counts only the workers of this checkout, not those of an installed plugin', () => {
    expect(isRepoWorker(`node ${path.join(DIST_DIR, 'sync-cli.js')}`)).toBe(true);
    const plugin = path.join(os.homedir(), '.claude', 'plugins', 'cache', 'm', 'episodic-memory', '9.9.9', 'dist', 'sync-cli.js');
    expect(isRepoWorker(`node ${plugin}`)).toBe(false);
  });

  it('sees a sacrificial sync-cli.js process, and sees it leave', async () => {
    const before = syncWorkerPids();
    // The argv names sync-cli.js. The child is ours, so the test kills it in `finally`.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)', path.join(DIST_DIR, 'sync-cli.js')], {
      stdio: 'ignore',
      windowsHide: true,
    });
    try {
      await waitUntil(() => child.pid !== undefined && syncWorkerPids().includes(child.pid), 30_000, 'the sacrificial worker to appear');
      expect(newSyncWorkers(before, syncWorkerPids())).toContain(child.pid);
    } finally {
      child.kill();
    }
    await waitUntil(() => newSyncWorkers(before, syncWorkerPids()).length === 0, 30_000, 'the sacrificial worker to exit');
  });
});

describe('e2e smoke: refusal guard and proc-lister seam', () => {
  it('refuses a learn agent subcommand by every route: umbrella, a flag first, and the learn bin', () => {
    const umbrella = path.join(CLI_DIR, 'episodic-memory.js');
    const learnBin = path.join(DIST_DIR, 'learn-cli.js');
    for (const [bin, args] of [
      [umbrella, ['learn', 'solve']],
      [umbrella, ['learn', '--project', 'x', 'improve']],
      [learnBin, ['bootstrap']],
      [learnBin, ['--project', 'x', 'solve']],
    ] as const) {
      expect(argvViolations(bin, args, undefined, sb.root, []).join(' ')).toMatch(/runs the Agent SDK/);
      expect(argvViolations(bin, args, undefined, sb.root, ['learn-agent'])).toEqual([]);
    }
    // Control: the same word outside a learn command is no agent run.
    expect(argvViolations(umbrella, ['search', 'solve'], undefined, sb.root, [])).toEqual([]);
  });


  it('refuses a path outside the sandbox and a never-set variable, and creates no directory', () => {
    const root = sb.root;
    const ghost = path.join(root, 'never-created');
    expect(buildEnv(sb, { env: { EPISODIC_MEMORY_CONFIG_DIR: ghost } }).EPISODIC_MEMORY_CONFIG_DIR).toBe(ghost);
    expect(existsSync(ghost)).toBe(false);
    // The real Claude folder of whichever machine runs the suite: a child must never reach it.
    expect(() => buildEnv(sb, { env: { CLAUDE_CONFIG_DIR: path.join(os.homedir(), '.claude') } })).toThrow(/outside the sandbox/);
    expect(() => buildEnv(sb, { env: { EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL: 'x' } })).toThrow(/must not be set/);
    expect(() => buildEnv(sb, { env: { EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:11434' } })).toThrow(/11434/);
    expect(() => buildEnv(sb, { env: { EPISODIC_MEMORY_PROC_LISTER: '/tmp/other.mjs' } })).toThrow(/PROC_LISTER/);
    // A case that names a never-set variable on purpose passes only through allowEnv.
    expect(buildEnv(sb, {
      env: { EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL: 'x' },
      allowEnv: ['EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL'],
    }).EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL).toBe('x');
    expect(envViolations({}, root).length).toBeGreaterThan(0);
  });

  it('builds the child env from nothing: no inherited machine variable reaches the child', () => {
    const env = buildEnv(sb);
    const keys = Object.keys(env).filter((key) => env[key] !== undefined);
    const allowed = new Set(['SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'PATH', 'TEMP', 'TMP', 'TMPDIR', 'EPISODIC_MEMORY_CONFIG_DIR',
      'CLAUDE_CONFIG_DIR', 'CODEX_HOME', 'HOME', 'USERPROFILE', 'XDG_CONFIG_HOME', 'FLEET_GPU_RESERVATION',
      'EPISODIC_MEMORY_SUMMARIZER_BACKEND', 'EPISODIC_MEMORY_OLLAMA_URL', 'EPISODIC_MEMORY_OLLAMA_MODEL',
      'EPISODIC_MEMORY_CODEX_BIN', 'EPISODIC_MEMORY_PROC_LISTER',
      // The shared model folder of the test run, and the switch that keeps the child from downloading.
      'EPISODIC_MEMORY_MODEL_DIR', 'EPISODIC_MEMORY_MODEL_OFFLINE']);
    expect(keys.filter((key) => !allowed.has(key))).toEqual([]);
    expect(env.PATH).toBe(sb.bin);
  });

  it('reports a pid only when its real command line carries the nonce, and on the second call only', async () => {
    const nonce = `e2e-lister-${process.pid}-${Date.now()}`;
    // A sacrificial child the test owns: its argv carries the nonce and the fork marker the reaper matches.
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', '--fork-session', nonce],
      { stdio: 'ignore', windowsHide: true });
    const pidFile = path.join(sb.root, 'lister-pid.txt');
    const saved = { file: process.env.E2E_LISTER_PID_FILE, nonce: process.env.E2E_LISTER_NONCE };
    try {
      expect(child.pid).toBeGreaterThan(0);
      writeFileSync(pidFile, String(child.pid), 'utf-8');
      process.env.E2E_LISTER_PID_FILE = pidFile;
      process.env.E2E_LISTER_NONCE = nonce;
      const lister = (await import(/* @vite-ignore */ LISTER_PATH)) as {
        listClaudeProcs: () => Array<{ pid: number; commandLine: string }>;
      };
      expect(lister.listClaudeProcs()).toEqual([]);
      const second = lister.listClaudeProcs();
      expect(second.map((p) => p.pid)).toEqual([child.pid]);
      expect(second[0].commandLine).toContain(nonce);
      expect(lister.listClaudeProcs()).toEqual([]);
    } finally {
      child.kill();
      if (saved.file === undefined) delete process.env.E2E_LISTER_PID_FILE; else process.env.E2E_LISTER_PID_FILE = saved.file;
      if (saved.nonce === undefined) delete process.env.E2E_LISTER_NONCE; else process.env.E2E_LISTER_NONCE = saved.nonce;
    }
  });

  it('reports nothing for a live pid whose real command line lacks the nonce', async () => {
    const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)', '--', '--fork-session', 'not-the-nonce'],
      { stdio: 'ignore', windowsHide: true });
    const pidFile = path.join(sb.root, 'lister-pid-neg.txt');
    const saved = { file: process.env.E2E_LISTER_PID_FILE, nonce: process.env.E2E_LISTER_NONCE };
    try {
      writeFileSync(pidFile, String(child.pid), 'utf-8');
      process.env.E2E_LISTER_PID_FILE = pidFile;
      process.env.E2E_LISTER_NONCE = 'nonce-that-is-not-in-argv';
      vi.resetModules();
      const lister = (await import(/* @vite-ignore */ LISTER_PATH)) as { listClaudeProcs: () => unknown[] };
      expect(lister.listClaudeProcs()).toEqual([]);
      expect(lister.listClaudeProcs()).toEqual([]);
    } finally {
      child.kill();
      if (saved.file === undefined) delete process.env.E2E_LISTER_PID_FILE; else process.env.E2E_LISTER_PID_FILE = saved.file;
      if (saved.nonce === undefined) delete process.env.E2E_LISTER_NONCE; else process.env.E2E_LISTER_NONCE = saved.nonce;
    }
  });
});

describe('e2e smoke: prompt classification', () => {
  // The header of each kind must still be the product's text. A product edit that moves a header
  // fails here, so the fake never silently classifies a real prompt as `other`.
  const SOURCES: Record<string, [string, string]> = {
    summary: ['src/summarizer.ts', 'Please write a concise, factual summary of this conversation.'],
    digest: ['src/digest-prompts.ts', 'Write the facts that a future session would need to continue this work.'],
    topic: ['src/topic-prompts.ts', 'Keep the topic documents of this project up to date with the conversation.'],
    learn: ['src/learn/tasks.ts', 'You write retrieval practice questions about a past conversation, for a system that must find'],
    compress: ['src/digest-prompts.ts', 'Merge these notes from ${span} of work into fewer, shorter lines.'],
  };

  it('finds every copied header line verbatim in its product source, and the marker in constants.ts', () => {
    const marker = 'Context: This summary will be shown in a list to help users and Claude choose which conversations are relevant';
    expect(readFileSync(path.join(REPO_ROOT, 'src', 'constants.ts'), 'utf-8')).toContain(marker);
    const missing: string[] = [];
    for (const [kind, [file, line]] of Object.entries(SOURCES) as [string, [string, string]][]) {
      if (!readFileSync(path.join(REPO_ROOT, file), 'utf-8').includes(line)) missing.push(`${kind}: ${line} not in ${file}`);
    }
    expect(missing).toEqual([]);
  });

  it('classifies a compression prompt that the shipped builder writes as compress, for both spans', async () => {
    const { buildCompressPrompt } = await import('../../dist/digest-prompts.js');
    const entry = { text: 'The build moved to a Linux runner. [#e2e-mark]' };
    for (const span of ['day', 'week'] as const) {
      expect(classifyPrompt(buildCompressPrompt([entry as never], span).prompt)).toBe('compress');
    }
  });

  it('classifies each header as its own kind', () => {
    expect(classifyPrompt(PROMPT_HEADERS.summary + '\n\nmore')).toBe('summary');
    expect(classifyPrompt(PROMPT_HEADERS.digest + '\n\nmore')).toBe('digest');
    expect(classifyPrompt(PROMPT_HEADERS.topic + '\n\nmore')).toBe('topic');
    expect(classifyPrompt(PROMPT_HEADERS.learn + '\n\nmore')).toBe('learn');
    expect(classifyPrompt(PROMPT_HEADERS.compress + 'week of work')).toBe('compress');
    expect(classifyPrompt('an unrelated prompt')).toBe('other');
  });

  it('keeps a prompt of one kind as that kind when its body quotes every other header and marker', () => {
    const others = Object.entries(PROMPT_HEADERS);
    for (const [kind, header] of others) {
      const quoted = others.filter(([k]) => k !== kind).map(([, h]) => h).join('\n---\n')
        + '\n[1] User: x\n=== FILE x\n<tier1>\nlocate: y\n<summary></summary> tags';
      expect(classifyPrompt(`${header}\n\n${quoted}`)).toBe(kind);
    }
  });
});

/** The number of .jsonl files under `dir`, at any depth. 0 when the folder is absent. */
function countJsonl(dir: string): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countJsonl(path.join(dir, entry.name));
    else if (entry.name.endsWith('.jsonl')) n += 1;
  }
  return n;
}

/** One POST to the fake's /api/generate, with the product's request shape. */
async function postGenerate(url: string, prompt: string, options: Record<string, unknown>): Promise<{ response: string }> {
  const res = await fetch(`${url}/api/generate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'e2e-fake', prompt, stream: false, think: false, options }),
  });
  return (await res.json()) as { response: string };
}

describe('e2e smoke: hooks, sync log, digest seed and scripted replies', () => {
  it('runs digest-hook with the digest off: exit 0 and no output', async () => {
    const hookSb = makeSandbox();
    try {
      const r = await runHook(hookSb, 'digest-hook', { cwd: path.join(hookSb.root, 'project') });
      expect(r.code).toBe(0);
      expect(r.stdout).toBe('');
    } finally {
      removeSandbox(hookSb);
    }
  });

  it('runs sync-hook with auto-sync off: the hook log names the reaper, and no background sync begins', async () => {
    const hookSb = makeSandbox();
    try {
      const r = await runHook(hookSb, 'sync-hook', { cwd: path.join(hookSb.root, 'project') }, {
        env: { EPISODIC_MEMORY_DISABLE_AUTO_SYNC: '1' },
      });
      expect(r.code).toBe(0);
      // The reaper logs on every path, so its line proves the hook ran the reaper.
      expect(readHookLog(hookSb)).toContain('orphan-reaper:');
      // The worker log stays empty: the sync child exits before it starts a worker.
      expect(readSyncLog(hookSb)).toBe('');
      expect(existsSync(syncLockPath(hookSb))).toBe(false);
    } finally {
      removeSandbox(hookSb);
    }
  });

  it('a SessionStart sync copies the transcript into the archive once the background worker exits', async () => {
    const hookSb = makeSandbox();
    try {
      seedTranscript(hookSb, 'e2e-hook', 'short-conversation.jsonl');
      const before = syncWorkerPids();
      const r = await runHook(hookSb, 'sync-hook', { cwd: path.join(hookSb.root, 'e2e-hook') }, {
        env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' },
      });
      expect(r.code).toBe(0);
      // The inspect callback runs after the worker is gone and before the sandbox is removed.
      await waitForBackgroundSync(hookSb, before, 120_000, () => {
        expect(countJsonl(hookSb.archive)).toBeGreaterThan(0);
        expect(readSyncLog(hookSb)).toContain('Starting background sync');
      });
      expect(existsSync(hookSb.root)).toBe(false);
    } finally {
      if (existsSync(hookSb.root)) removeSandbox(hookSb);
    }
  }, 180_000);

  it('seeds a session the digest does not skip, and the index then holds both of its exchanges', async () => {
    const file = seedDigestableSession(sb, 'e2e-digest', { exchanges: 2, ageMinutes: 60 });
    type Turn = { type: string; timestamp: string; message: { content: Array<{ text: string }> } };
    const records = readFileSync(file, 'utf-8').trim().split('\n').map((line) => JSON.parse(line) as Turn);
    expect(records.map((r) => r.type)).toEqual(['user', 'assistant', 'user', 'assistant']);
    for (let i = 0; i < 2; i++) {
      const chars = records[2 * i].message.content[0].text.length + records[2 * i + 1].message.content[0].text.length;
      expect(chars).toBeGreaterThan(100);
    }
    const thirtyMinutesAgo = Date.now() - 30 * 60_000;
    for (const r of records) expect(Date.parse(r.timestamp)).toBeLessThan(thirtyMinutesAgo);

    const sync = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], { env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' } });
    expect(sync.code).toBe(0);
    const index = await runCli(sb, cliBin('episodic-memory.js'), ['index', '--no-summaries']);
    expect(index.code).toBe(0);
    const db = openIndexDb(sb);
    try {
      const row = db.prepare('SELECT COUNT(*) AS n FROM exchanges WHERE project = ?').get('e2e-digest') as { n: number };
      expect(row.n).toBe(2);
    } finally {
      db.close();
    }
  });

  it('answers a scripted reply, and records the options and think that each request sent', async () => {
    const fake = await fakeOllama('ok');
    try {
      fake.setReply('summary', '<summary>SCRIPTED MARKER</summary>');
      const summary = await postGenerate(fake.url, `${PROMPT_HEADERS.summary}\n\nUse <summary></summary> tags.`, { temperature: 0, num_ctx: 4096 });
      expect(summary.response).toBe('<summary>SCRIPTED MARKER</summary>');
      const seen = fake.requests[fake.requests.length - 1];
      expect(seen.kind).toBe('summary');
      expect(seen.model).toBe('e2e-fake');
      expect(seen.think).toBe(false);
      expect(seen.options).toEqual({ temperature: 0, num_ctx: 4096 });

      fake.setReply('digest', (prompt) => `Scripted digest of ${prompt.length} characters. [1]`);
      const digest = await postGenerate(fake.url, `${PROMPT_HEADERS.digest}\n\n[1] User: hi`, { temperature: 0 });
      expect(digest.response).toMatch(/^Scripted digest of \d+ characters\. \[1\]$/);

      fake.setReply('summary', null);
      const restored = await postGenerate(fake.url, `${PROMPT_HEADERS.summary}\n\nUse <summary></summary> tags.`, {});
      expect(restored.response).toContain('E2E summary MARKER');
    } finally {
      await fake.close();
    }
  });
});

describe('isolation: the real-folder leak check', () => {
  it('names a listing line whose file is a seeded transcript, and ignores every other file', () => {
    const sb = makeSandbox();
    try {
      const seeded = seedTranscript(sb, 'e2e-leak-control', 'tiny-conversation.jsonl');
      const name = path.basename(seeded);
      const listing = [
        `conversation-archive/e2e-leak-control/${name}\t10\t1`,
        'conversation-archive/other/11111111-2222-3333-4444-555555555555.jsonl\t10\t1',
        'conversation-index/db.sqlite\t10\t1',
      ];
      expect(leakedSeedFiles(listing)).toEqual([listing[0]]);
      expect(leakedSeedFiles(listing.slice(1))).toEqual([]);
    } finally {
      removeSandbox(sb);
    }
  });
});
