/**
 * The environment variables of the registry (cases.ts ENV_VARS) that no other e2e file names. Each
 * case sets one variable and asserts its effect, and asserts the default without it. A variable
 * whose effect needs a real agent, a real Codex binary or a network is named in a guard case only:
 * the refusal guard of the harness (harness.ts buildEnv) must refuse it.
 *
 * A case that fails because the PRODUCT is wrong is `it.skip('Dn pending: ...')`. No assertion is
 * weakened to make a case pass.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  McpClient, buildEnv, cliBin, fakeOllama, makeSandbox, openIndexDb, removeSandbox, runCli, runHook,
  seedDigestableSession, seedTranscript, textOf,
  type CliResult, type FakeOllama, type FakeRequest, type Sandbox,
} from './harness.js';
import { useIsolation } from './isolation.js';

useIsolation();

/** The budget of one child. The case timeout is 120 s (vitest.e2e.config.ts). */
const CHILD_MS = 100_000;
/** The case budget of a case that runs more than one child. */
const CASE_MS = 300_000;
/** A transcript of the fixture folder that holds the word `authentication`. */
const FIXTURE = 'short-conversation.jsonl';
/** The summary that the fake model writes for a summary prompt (harness.ts fakeReply). */
const SUMMARY_MARKER = 'E2E summary MARKER';

/** Run the umbrella CLI in `sb`. A case that needs the fake model passes its URL in `env`. */
function cli(sb: Sandbox, args: readonly string[], env: Record<string, string | undefined> = {}): Promise<CliResult> {
  return runCli(sb, cliBin('episodic-memory.js'), args, { env, timeoutMs: CHILD_MS });
}

/** The archived transcripts under the archive folder of `root`, as paths. Missing folders hold none. */
function archivedUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.jsonl')) found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

describe('env: refusal guard (no child is spawned)', () => {
  it('refuses every TEST_* variable: the test process pins them, a child never receives one', () => {
    const sb = makeSandbox();
    try {
      for (const name of ['TEST_DB_PATH', 'TEST_ARCHIVE_DIR', 'TEST_PROJECTS_DIR']) {
        expect(() => buildEnv(sb, { env: { [name]: path.join(sb.root, 'x') } }), name).toThrow(name);
      }
    } finally {
      removeSandbox(sb);
    }
  });

  it('refuses the variables that reach the live plugin, the network or a real API', () => {
    const sb = makeSandbox();
    try {
      for (const name of ['CLAUDE_PLUGIN_ROOT', 'PLUGIN_ROOT', 'EPISODIC_MEMORY_API_BASE_URL', 'EPISODIC_MEMORY_API_TOKEN']) {
        expect(() => buildEnv(sb, { env: { [name]: path.join(sb.root, 'x') } }), name).toThrow(name);
      }
    } finally {
      removeSandbox(sb);
    }
  });

  it('refuses a Codex summarizer, whose model and timeout variables reach a real Codex binary', () => {
    const sb = makeSandbox();
    try {
      for (const name of ['EPISODIC_MEMORY_CODEX_MODEL', 'EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS']) {
        expect(() => buildEnv(sb, { env: { EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'codex', [name]: '1' } }), name)
          .toThrow(/SUMMARIZER_BACKEND=codex/);
      }
    } finally {
      removeSandbox(sb);
    }
  });

  it('refuses a personal folder outside the sandbox', () => {
    const sb = makeSandbox();
    try {
      expect(() => buildEnv(sb, { env: { PERSONAL_SUPERPOWERS_DIR: path.join(path.dirname(sb.root), 'outside') } }))
        .toThrow('PERSONAL_SUPERPOWERS_DIR is outside the sandbox');
    } finally {
      removeSandbox(sb);
    }
  });
});

describe('env: paths and priority', () => {
  it('EPISODIC_MEMORY_CONFIG_DIR wins: PERSONAL_SUPERPOWERS_DIR is not read, and its folder is never created', async () => {
    const sb = makeSandbox();
    try {
      const personal = path.join(sb.root, 'personal');
      seedTranscript(sb, 'e2e-env-personal', FIXTURE);
      const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', PERSONAL_SUPERPOWERS_DIR: personal });
      expect(sync.code, sync.stderr).toBe(0);
      expect(archivedUnder(sb.archive)).toHaveLength(1);
      expect(existsSync(personal)).toBe(false);
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_DB_PATH moves the index database: the file appears at that path and the default index file does not', async () => {
    const sb = makeSandbox();
    try {
      seedTranscript(sb, 'e2e-env-db', FIXTURE);
      const dbPath = path.join(sb.root, 'custom', 'index.sqlite');
      mkdirSync(path.dirname(dbPath), { recursive: true });
      const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_DB_PATH: dbPath });
      expect(sync.code, sync.stderr).toBe(0);
      expect(existsSync(dbPath)).toBe(true);
      expect(existsSync(path.join(sb.index, 'db.sqlite'))).toBe(false);
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_BACKGROUND_WORKER=1 lowers the priority of a foreground sync and says so; unset, it does not', async () => {
    const sb = makeSandbox();
    try {
      seedTranscript(sb, 'e2e-env-worker', FIXTURE);
      const line = 'background worker running at below-normal priority';
      const on = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_BACKGROUND_WORKER: '1' });
      expect(on.code, on.stderr).toBe(0);
      expect(on.stderr).toContain(line);
      const off = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(off.code, off.stderr).toBe(0);
      expect(off.stderr).not.toContain(line);
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);
});

describe('env: the pinned locations and the model name', () => {
  it('XDG_CONFIG_HOME holds the data folder when EPISODIC_MEMORY_CONFIG_DIR is empty; with it set, the XDG folder stays empty', async () => {
    const sb = makeSandbox();
    try {
      seedTranscript(sb, 'e2e-env-xdg', FIXTURE);
      const xdgData = path.join(sb.xdg, 'superpowers');
      const viaXdg = await runCli(sb, cliBin('episodic-memory.js'), ['sync'], {
        env: { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_CONFIG_DIR: '', XDG_CONFIG_HOME: sb.xdg },
        allowEnv: ['EPISODIC_MEMORY_CONFIG_DIR'], timeoutMs: CHILD_MS,
      });
      expect(viaXdg.code, viaXdg.stderr).toBe(0);
      expect(archivedUnder(path.join(xdgData, 'conversation-archive'))).toHaveLength(1);
      expect(archivedUnder(sb.archive)).toHaveLength(0);
      const control = makeSandbox();
      try {
        seedTranscript(control, 'e2e-env-xdg', FIXTURE);
        const viaConfig = await cli(control, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
        expect(viaConfig.code, viaConfig.stderr).toBe(0);
        expect(archivedUnder(control.archive)).toHaveLength(1);
        expect(existsSync(path.join(control.xdg, 'superpowers'))).toBe(false);
      } finally {
        removeSandbox(control);
      }
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);

  it('CODEX_HOME names the Codex home that doctor codex reports, and its sessions folder', async () => {
    const sb = makeSandbox();
    try {
      const other = path.join(sb.root, 'other-codex');
      mkdirSync(path.join(other, 'sessions'), { recursive: true });
      const moved = await cli(sb, ['doctor', 'codex'], { CODEX_HOME: other });
      expect(moved.stdout).toContain(`Codex home: ${other}`);
      expect(moved.stdout).toContain('Codex sessions: found');
      const pinned = await cli(sb, ['doctor', 'codex']);
      expect(pinned.stdout).toContain(`Codex home: ${sb.codex}`);
      expect(pinned.stdout).toContain('Codex sessions: missing');
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_OLLAMA_MODEL is the model name of every summary request', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      seedTranscript(sb, 'e2e-env-model', FIXTURE);
      const first = fake.requests.length;
      const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_OLLAMA_MODEL: 'e2e-other-model' });
      expect(sync.code, sync.stderr).toBe(0);
      const summaries = fake.requests.slice(first).filter((r) => r.kind === 'summary');
      expect(summaries.length).toBeGreaterThan(0);
      expect(new Set(summaries.map((r) => r.model))).toEqual(new Set(['e2e-other-model']));
    } finally {
      await fake.close();
      removeSandbox(sb);
    }
  }, CASE_MS);
});

/** The summary requests that the fake model received after `from` (an index into its request log). */
function summaryRequestsSince(fake: FakeOllama, from: number): number {
  return fake.requests.slice(from).filter((r) => r.kind === 'summary').length;
}

describe('env: summaries and the read cap, on one summarized index', () => {
  let sb: Sandbox;
  let fake: FakeOllama;
  let archived = '';

  beforeAll(async () => {
    sb = makeSandbox();
    fake = await fakeOllama('ok');
    seedTranscript(sb, 'e2e-env-summary', FIXTURE);
    const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url });
    expect(sync.code, sync.stderr).toBe(0);
    // The fake answered the summary prompt: a zero-write run would not show it.
    expect(summaryRequestsSince(fake, 0)).toBeGreaterThan(0);
    archived = archivedUnder(sb.archive)[0] ?? '';
    expect(archived).not.toBe('');
  }, CASE_MS);

  afterAll(async () => {
    await fake.close();
    removeSandbox(sb);
  });

  it('shows the stored summary in search by default', async () => {
    const found = await cli(sb, ['search', 'authentication', '--text']);
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).toContain(SUMMARY_MARKER);
  });

  it('hides the summary from search with EPISODIC_MEMORY_INCLUDE_SUMMARY=0', async () => {
    const found = await cli(sb, ['search', 'authentication', '--text'], { EPISODIC_MEMORY_INCLUDE_SUMMARY: '0' });
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).not.toContain(SUMMARY_MARKER);
  });

  it('cuts the shown summary to EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS: a 5-character cap drops the marker', async () => {
    const found = await cli(sb, ['search', 'authentication', '--text'], { EPISODIC_MEMORY_MAX_SUMMARY_DISPLAY_CHARS: '5' });
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).not.toContain(SUMMARY_MARKER);
    // The row still prints, so the cut is the summary's and not the whole hit.
    expect(found.stdout).toContain('e2e-env-summary');
    expect(found.stdout).toContain('E2E s…');
  });

  it('refuses a read of the archive file over EPISODIC_MEMORY_MAX_READ_BYTES, and serves it at the default cap', async () => {
    const small = await McpClient.start(sb, { env: { EPISODIC_MEMORY_MAX_READ_BYTES: '10' } });
    try {
      const refused = await small.call('read', { path: archived });
      expect(refused.isError, textOf(refused)).toBe(true);
      expect(textOf(refused)).toContain('EPISODIC_MEMORY_MAX_READ_BYTES');
    } finally {
      await small.close();
    }
    const normal = await McpClient.start(sb);
    try {
      const served = await normal.call('read', { path: archived });
      expect(served.isError, textOf(served)).not.toBe(true);
      expect(textOf(served)).toContain('authentication');
    } finally {
      await normal.close();
    }
  }, CASE_MS);
});

describe('env: refusal guard for the Claude summarizer (no child is spawned)', () => {
  it('refuses the Claude summarizer, whose timeout and model variables reach the Agent SDK', () => {
    const sb = makeSandbox();
    try {
      for (const name of ['EPISODIC_MEMORY_API_TIMEOUT_MS', 'EPISODIC_MEMORY_API_MODEL', 'EPISODIC_MEMORY_API_MODEL_FALLBACK']) {
        expect(() => buildEnv(sb, { env: { EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'claude', [name]: '1' } }), name)
          .toThrow(/SUMMARIZER_BACKEND=claude/);
      }
    } finally {
      removeSandbox(sb);
    }
  });
});

/** Two exchanges. The user message is `size` characters long and starts with `word`, so the cap can cut it. */
function longMessageLines(word: string, size: number): string[] {
  const sessionId = randomUUID();
  const base = { isSidechain: false, userType: 'external', cwd: '/e2e/env-message', sessionId, version: '2.0.9' };
  const stamp = (step: number): string => new Date(Date.now() - 3_600_000 + step * 1000).toISOString();
  const body = `${word} ${'lorem ipsum dolor sit amet '.repeat(Math.ceil(size / 28))}`.slice(0, size);
  const userUuid = randomUUID();
  return [
    JSON.stringify({ ...base, uuid: userUuid, parentUuid: null, type: 'user', timestamp: stamp(0),
      message: { role: 'user', content: [{ type: 'text', text: body }] } }),
    JSON.stringify({ ...base, uuid: randomUUID(), parentUuid: userUuid, type: 'assistant', timestamp: stamp(1),
      message: { role: 'assistant', content: [{ type: 'text', text: 'The agent answers the runner build question.' }] } }),
  ];
}

describe('env: index cap and summary attempts', () => {
  it('EPISODIC_MEMORY_MAX_MESSAGE_BYTES=200 cuts an indexed message and marks the cut; the default keeps it whole', async () => {
    const capped = makeSandbox();
    const whole = makeSandbox();
    try {
      for (const sb of [capped, whole]) seedTranscript(sb, 'e2e-env-message', longMessageLines('zebrafish', 900));
      const cut = await cli(capped, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_MAX_MESSAGE_BYTES: '200' });
      expect(cut.code, cut.stderr).toBe(0);
      const kept = await cli(whole, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(kept.code, kept.stderr).toBe(0);
      const indexed = (sb: Sandbox): string => {
        const db = openIndexDb(sb);
        try {
          const row = db.prepare('SELECT user_message AS text FROM exchanges WHERE user_message LIKE ?').get('%zebrafish%') as { text: string } | undefined;
          expect(row, 'the indexed exchange').toBeDefined();
          return row!.text;
        } finally {
          db.close();
        }
      };
      expect(indexed(capped)).toContain('[truncated by episodic-memory: 900 chars exceeded the 200-char index cap]');
      expect(indexed(whole)).not.toContain('[truncated by episodic-memory');
      expect(indexed(whole).length).toBeGreaterThanOrEqual(900);
    } finally {
      removeSandbox(capped);
      removeSandbox(whole);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS=2 stops asking for a summary that never comes back after two failed syncs; the default stops after three', async () => {
    for (const [attempts, expected] of [['2', 2], [undefined, 3]] as const) {
      const sb = makeSandbox();
      const fake = await fakeOllama('no-summary-block');
      try {
        seedDigestableSession(sb, 'e2e-env-attempts', { exchanges: 2 });
        // Each sync is one attempt; the sidecar keeps the count, so four syncs reach the cap in both runs.
        for (let i = 0; i < 4; i++) {
          const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS: attempts });
          expect(sync.code, sync.stderr).toBe(0);
        }
        expect(summaryRequestsSince(fake, 0)).toBe(expected);
      } finally {
        await fake.close();
        removeSandbox(sb);
      }
    }
  }, CASE_MS);
});

describe('env: summary limit per run', () => {
  it('EPISODIC_MEMORY_SUMMARY_LIMIT=1 summarizes one session per sync; the next sync without it summarizes the rest', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      // Three sessions that the summarizer takes (the tiny fixture is too short to summarize).
      for (const project of ['e2e-env-limit-a', 'e2e-env-limit-b', 'e2e-env-limit-c']) {
        seedDigestableSession(sb, project, { exchanges: 2 });
      }
      const first = fake.requests.length;
      const limited = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_SUMMARY_LIMIT: '1' });
      expect(limited.code, limited.stderr).toBe(0);
      expect(summaryRequestsSince(fake, first)).toBe(1);
      const second = fake.requests.length;
      const rest = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url });
      expect(rest.code, rest.stderr).toBe(0);
      expect(summaryRequestsSince(fake, second)).toBe(2);
    } finally {
      await fake.close();
      removeSandbox(sb);
    }
  }, CASE_MS);
});

/** Every file under `dir`, recursively. A missing folder holds none. */
function filesUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else found.push(full);
    }
  };
  if (existsSync(dir)) walk(dir);
  return found;
}

describe('summaries: a failing model', () => {
  for (const mode of ['500', 'empty'] as const) {
    it(`a model that answers ${mode === '500' ? 'HTTP 500' : 'with an empty body'} leaves no summary, writes a failure record, and sync still exits 0`, async () => {
      const sb = makeSandbox();
      const fake = await fakeOllama(mode);
      try {
        seedTranscript(sb, `e2e-model-${mode}`, FIXTURE);
        const sync = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url });
        expect(sync.code, sync.stderr).toBe(0);
        expect(fake.requests.filter((r) => r.kind === 'summary').length).toBeGreaterThan(0);
        const files = filesUnder(sb.archive);
        expect(files.filter((file) => file.endsWith('-summary.txt'))).toEqual([]);
        expect(files.filter((file) => file.endsWith('-summary.failed'))).toHaveLength(1);
      } finally {
        await fake.close();
        removeSandbox(sb);
      }
    }, CASE_MS);
  }
});

describe('env: summary byte ceiling and the Ollama prompt cap', () => {
  it('EPISODIC_MEMORY_MAX_SUMMARY_BYTES=100 skips the summary of a larger transcript: no model call, and the failure record names the ceiling', async () => {
    const capped = makeSandbox();
    const whole = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      seedTranscript(capped, 'e2e-env-bytes', FIXTURE);
      seedTranscript(whole, 'e2e-env-bytes', FIXTURE);
      const first = fake.requests.length;
      const skip = await cli(capped, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_MAX_SUMMARY_BYTES: '100' });
      expect(skip.code, skip.stderr).toBe(0);
      expect(summaryRequestsSince(fake, first)).toBe(0);
      const records = filesUnder(capped.archive).filter((file) => file.endsWith('-summary.failed'));
      expect(records).toHaveLength(1);
      expect(readFileSync(records[0], 'utf-8')).toContain('EPISODIC_MEMORY_MAX_SUMMARY_BYTES (100)');
      const second = fake.requests.length;
      const kept = await cli(whole, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url });
      expect(kept.code, kept.stderr).toBe(0);
      expect(summaryRequestsSince(fake, second)).toBeGreaterThan(0);
    } finally {
      await fake.close();
      removeSandbox(capped);
      removeSandbox(whole);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS=1000 sends every summary prompt at 1000 characters; the default sends a longer one', async () => {
    const capped = makeSandbox();
    const whole = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      seedTranscript(capped, 'e2e-env-prompt', longMessageLines('zebrafish', 900));
      seedTranscript(whole, 'e2e-env-prompt', longMessageLines('zebrafish', 900));
      const first = fake.requests.length;
      const cut = await cli(capped, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_OLLAMA_MAX_PROMPT_CHARS: '1000' });
      expect(cut.code, cut.stderr).toBe(0);
      const cutLengths = fake.requests.slice(first).filter((r) => r.kind === 'summary').map((r) => r.promptLength);
      expect(cutLengths).toEqual([1000]);
      const second = fake.requests.length;
      const full = await cli(whole, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url });
      expect(full.code, full.stderr).toBe(0);
      const fullLengths = fake.requests.slice(second).filter((r) => r.kind === 'summary').map((r) => r.promptLength);
      expect(fullLengths).toHaveLength(1);
      expect(fullLengths[0]).toBeGreaterThan(1000);
    } finally {
      await fake.close();
      removeSandbox(capped);
      removeSandbox(whole);
    }
  }, CASE_MS);
});

describe('env: redaction of the indexed text', () => {
  it('EPISODIC_MEMORY_REDACT_SECRETS=1 stores a token-shaped string as [redacted]; unset, the index keeps it as written', async () => {
    // Built at run time: a token-shaped literal in a test file trips the repository privacy scan.
    const token = `${['gh', 'p'].join('')}_${'A1'.repeat(18)}`;
    const redacted = makeSandbox();
    const plain = makeSandbox();
    try {
      for (const sb of [redacted, plain]) seedTranscript(sb, 'e2e-env-redact', longMessageLines(token, 200));
      const on = await cli(redacted, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_REDACT_SECRETS: '1' });
      expect(on.code, on.stderr).toBe(0);
      const off = await cli(plain, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(off.code, off.stderr).toBe(0);
      const stored = (sb: Sandbox): string[] => {
        const db = openIndexDb(sb);
        try {
          return (db.prepare('SELECT user_message AS text FROM exchanges').all() as Array<{ text: string }>).map((r) => r.text);
        } finally {
          db.close();
        }
      };
      expect(stored(redacted).length).toBeGreaterThan(0);
      for (const text of stored(redacted)) expect(text).not.toContain(token);
      expect(stored(redacted).some((text) => text.includes('[redacted]'))).toBe(true);
      expect(stored(plain).some((text) => text.includes(token))).toBe(true);
    } finally {
      removeSandbox(redacted);
      removeSandbox(plain);
    }
  }, CASE_MS);
});

/** A sandbox with one indexed session whose every row is stale: its embedding version is 0. Returns the row count. */
async function staleIndex(sb: Sandbox): Promise<number> {
  seedDigestableSession(sb, 'e2e-env-migrate', { exchanges: 3 });
  const indexed = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
  expect(indexed.code, indexed.stderr).toBe(0);
  const writer = new DatabaseSync(path.join(sb.index, 'db.sqlite'));
  try {
    writer.exec('UPDATE exchanges SET embedding_version = 0');
  } finally {
    writer.close();
  }
  return staleRows(sb);
}

/** Rows that still hold embedding version 0, read by the test itself. */
function staleRows(sb: Sandbox): number {
  const db = openIndexDb(sb);
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM exchanges WHERE embedding_version = 0').get() as { c: number }).c;
  } finally {
    db.close();
  }
}

describe('env: embedding migration batch', () => {
  it('EPISODIC_MEMORY_MIGRATION_BATCH=1 re-embeds one stale row per sync; the default re-embeds every stale row', async () => {
    const capped = makeSandbox();
    const whole = makeSandbox();
    try {
      const staleCapped = await staleIndex(capped);
      const staleWhole = await staleIndex(whole);
      expect(staleCapped).toBeGreaterThanOrEqual(2);
      const one = await cli(capped, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_MIGRATION_BATCH: '1' });
      expect(one.code, one.stderr).toBe(0);
      expect(one.stderr).toContain('migrating up to 1 this run');
      expect(staleRows(capped)).toBe(staleCapped - 1);
      const all = await cli(whole, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(all.code, all.stderr).toBe(0);
      expect(all.stderr).toContain('migrating up to 500 this run');
      expect(staleRows(whole)).toBe(0);
      expect(staleWhole).toBeGreaterThanOrEqual(2);
    } finally {
      removeSandbox(capped);
      removeSandbox(whole);
    }
  }, CASE_MS);

  it.skip('D12 pending: MIGRATION_BATCH=-1 -> "migrating up to -1 this run" (LIMIT -1 is unlimited); MIGRATION_BATCH=abc -> "migrating up to NaN this run"; expected 500 for both', async () => {
    const sb = makeSandbox();
    try {
      await staleIndex(sb);
      for (const value of ['-1', 'abc']) {
        const run = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_MIGRATION_BATCH: value });
        expect(run.code, run.stderr).toBe(0);
        expect(run.stderr, `MIGRATION_BATCH=${value}`).toContain('migrating up to 500 this run');
      }
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);
});

describe('env: database busy timeout', () => {
  it('EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS=8000 waits on a held write lock for its timeout; 100 gives up seconds sooner', async () => {
    const sb = makeSandbox();
    try {
      seedTranscript(sb, 'e2e-env-busy-base', FIXTURE);
      const base = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(base.code, base.stderr).toBe(0);
      // The test process holds the write lock of the index for the length of both children.
      const writer = new DatabaseSync(path.join(sb.index, 'db.sqlite'));
      try {
        writer.exec('BEGIN IMMEDIATE');
        seedTranscript(sb, 'e2e-env-busy-fast', FIXTURE);
        const started = Date.now();
        const fast = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS: '100' });
        const fastMs = Date.now() - started;
        seedTranscript(sb, 'e2e-env-busy-slow', FIXTURE);
        const begun = Date.now();
        const slow = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS: '8000' });
        const slowMs = Date.now() - begun;
        const detail = JSON.stringify({ fastMs, slowMs, fastCode: fast.code, slowCode: slow.code });
        // The slow child waits at least its own timeout (lower bound 7.5 s of 8 s). The gap to the
        // fast child is 7.9 s by the settings; 4 s leaves room for a slow start of either child.
        expect(slowMs, detail).toBeGreaterThanOrEqual(7500);
        expect(slowMs - fastMs, detail).toBeGreaterThanOrEqual(4000);
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);

  it.skip('D13 pending: sync with a write lock held by another connection -> exit 0, no stderr line, the new transcript not indexed (measured with busy timeout 100 and 8000); expected a stderr line that names the failed write', async () => {
    const sb = makeSandbox();
    try {
      seedTranscript(sb, 'e2e-env-busy-base', FIXTURE);
      const base = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1' });
      expect(base.code, base.stderr).toBe(0);
      const writer = new DatabaseSync(path.join(sb.index, 'db.sqlite'));
      try {
        writer.exec('BEGIN IMMEDIATE');
        seedTranscript(sb, 'e2e-env-busy-fast', FIXTURE);
        const fast = await cli(sb, ['sync'], { EPISODIC_MEMORY_SKIP_SUMMARIES: '1', EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS: '100' });
        expect(fast.code, fast.stderr).not.toBe(0);
        expect(fast.stderr).toMatch(/locked|busy/i);
      } finally {
        writer.exec('ROLLBACK');
        writer.close();
      }
    } finally {
      removeSandbox(sb);
    }
  }, CASE_MS);
});

/** The rows of one digest tier in the sandbox index, read by the test. */
function digestTierRows(sb: Sandbox, tier: string): number {
  const db = openIndexDb(sb);
  try {
    return (db.prepare('SELECT COUNT(*) AS c FROM digest_entry WHERE tier = ?').get(tier) as { c: number }).c;
  } finally {
    db.close();
  }
}

/** The project key that the digest hook derives from a working directory (src/digest-inject.ts projectKeyFromCwd). */
function keyOf(cwd: string): string {
  return cwd.replace(/[^A-Za-z0-9]/g, '-');
}

/** Run one sync with the digest on and the fake model. Returns the requests it made, by kind. */
async function digestSync(sb: Sandbox, fake: FakeOllama, env: Record<string, string> = {}): Promise<FakeRequest[]> {
  const before = fake.requests.length;
  const run = await cli(sb, ['sync'], { EPISODIC_MEMORY_OLLAMA_URL: fake.url, EPISODIC_MEMORY_DIGEST: '1', ...env });
  expect(run.code, run.stderr).toBe(0);
  return fake.requests.slice(before);
}

describe('env: digest limits', () => {
  it('EPISODIC_MEMORY_DIGEST_MAX_SESSIONS=1 digests one session per run; the default digests both in the next run', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      seedDigestableSession(sb, 'e2e-env-digest-max', { exchanges: 2, ageMinutes: 60 });
      seedDigestableSession(sb, 'e2e-env-digest-max', { exchanges: 2, ageMinutes: 90 });
      const capped = await digestSync(sb, fake, { EPISODIC_MEMORY_DIGEST_MAX_SESSIONS: '1' });
      expect(capped.filter((r) => r.kind === 'digest')).toHaveLength(1);
      expect(digestTierRows(sb, 'session')).toBe(1);
      const rest = await digestSync(sb, fake);
      expect(rest.filter((r) => r.kind === 'digest')).toHaveLength(1);
      expect(digestTierRows(sb, 'session')).toBe(2);
    } finally {
      await fake.close();
      removeSandbox(sb);
    }
  }, CASE_MS);

  it('EPISODIC_MEMORY_DIGEST_MAX_CHARS=1 leaves no room for an entry, so the hook prints nothing; the default prints the digest', async () => {
    const sb = makeSandbox();
    const fake = await fakeOllama('ok');
    try {
      const cwd = path.join(sb.root, 'work');
      seedDigestableSession(sb, keyOf(cwd), { exchanges: 2, ageMinutes: 60 });
      await digestSync(sb, fake);
      const full = await runHook(sb, 'digest-hook', { cwd }, { env: { EPISODIC_MEMORY_DIGEST: '1' } });
      expect(full.code, full.stderr).toBe(0);
      expect(full.stdout).toContain('The user asked about X.');
      const tiny = await runHook(sb, 'digest-hook', { cwd }, { env: { EPISODIC_MEMORY_DIGEST: '1', EPISODIC_MEMORY_DIGEST_MAX_CHARS: '1' } });
      expect(tiny.code, tiny.stderr).toBe(0);
      expect(tiny.stdout).toBe('');
    } finally {
      await fake.close();
      removeSandbox(sb);
    }
  }, CASE_MS);

  describe('compression caps, on two sessions of each of two days in one earlier week', () => {
    let sb: Sandbox;
    let fake: FakeOllama;
    /** Each run's counts, taken right after that run: compression calls by span, and the rows by tier. */
    const seen: Record<'default' | 'day' | 'week', { calls: string[]; day: number; week: number }> = {
      default: { calls: [], day: 0, week: 0 },
      day: { calls: [], day: 0, week: 0 },
      week: { calls: [], day: 0, week: 0 },
    };

    /** The spans of the compression calls of one run, `day` or `week`. */
    function spansOf(requests: FakeRequest[]): string[] {
      return requests.filter((r) => r.kind === 'compress').map((r) => r.prompt.match(/one (day|week)/)?.[1] ?? '?');
    }

    beforeAll(async () => {
      sb = makeSandbox();
      fake = await fakeOllama('ok');
      // The fake answers a compression prompt (kind `compress`) with one line that cites a mark of its notes.
      const now = Date.now();
      const today = new Date(now);
      const dow = (today.getUTCDay() + 6) % 7;
      const monday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() - dow - 7, 12);
      // Two sessions on each of two days of last week. An hour apart, so no two sessions share a start time.
      for (const dayStart of [monday, monday + 86_400_000]) {
        for (const hour of [0, 1]) {
          const noon = dayStart + hour * 3_600_000;
          seedDigestableSession(sb, 'e2e-env-digest-cap', { exchanges: 2, ageMinutes: Math.round((now - noon) / 60_000) });
        }
      }
      const counts = (): { day: number; week: number } => ({ day: digestTierRows(sb, 'day'), week: digestTierRows(sb, 'week') });
      const first = await digestSync(sb, fake);
      seen.default = { calls: spansOf(first), ...counts() };
      const second = await digestSync(sb, fake, { EPISODIC_MEMORY_DIGEST_DAY_CAP: '1' });
      seen.day = { calls: spansOf(second), ...counts() };
      const third = await digestSync(sb, fake, { EPISODIC_MEMORY_DIGEST_DAY_CAP: '1', EPISODIC_MEMORY_DIGEST_WEEK_CAP: '1' });
      seen.week = { calls: spansOf(third), ...counts() };
    }, CASE_MS);

    afterAll(async () => {
      await fake.close();
      removeSandbox(sb);
    });

    it('the default caps merge no day and no week: no compression call and no day or week entry', () => {
      expect(seen.default.calls).toEqual([]);
      expect(seen.default.day).toBe(0);
      expect(seen.default.week).toBe(0);
    });

    it('EPISODIC_MEMORY_DIGEST_DAY_CAP=1 merges each of the two days: two day compression calls and two day entries', () => {
      expect(seen.day.calls).toEqual(['day', 'day']);
      expect(seen.day.day).toBe(2);
      expect(seen.day.week).toBe(0);
    });

    it('EPISODIC_MEMORY_DIGEST_WEEK_CAP=1 merges the two day entries of their week: one week compression call', () => {
      expect(seen.week.calls).toEqual(['week']);
    });

    it('EPISODIC_MEMORY_DIGEST_WEEK_CAP=1 stores the week entry of the merge', () => {
      expect(seen.week.week).toBe(1);
    });
  });
});
