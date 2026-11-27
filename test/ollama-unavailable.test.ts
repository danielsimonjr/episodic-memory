import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { safeRmSync } from './test-utils.js';

// The Ollama endpoint is faked with fetch stubs. No test reaches a real model server.
const { callOllama, OllamaUnavailableError } = await import('../src/ollama-backend.js');
const { deferralDetail } = await import('../src/deferral.js');
const { summarizeConversation } = await import('../src/summarizer.js');
const { syncConversations } = await import('../src/sync.js');

const KEYS = [
  'EPISODIC_MEMORY_SUMMARIZER_BACKEND',
  'EPISODIC_MEMORY_OLLAMA_URL',
  'EPISODIC_MEMORY_OLLAMA_MODEL',
  'EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL',
  'EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS',
  'FLEET_GPU_RESERVATION',
];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

// The error shape that Node's fetch gives for a refused connection.
function refused(): TypeError {
  const cause = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:9'), { code: 'ECONNREFUSED' });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

// A fetch that never answers until the caller's signal aborts it.
const hangingFetch = (async (_url: string, init: any) => new Promise((_resolve, reject) => {
  init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
})) as any;

const httpStatus = (status: number) => (async () => new Response('{}', { status })) as any;

beforeEach(() => {
  process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
  process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'unit-model';
  delete process.env.EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('callOllama: a refused connection is a backend outage', () => {
  it('throws OllamaUnavailableError with the endpoint and the cause in the detail', async () => {
    const err = await callOllama('x', { fetchImpl: (async () => { throw refused(); }) as any }).catch((e) => e);
    expect(err).toBeInstanceOf(OllamaUnavailableError);
    expect((err as Error).message).toContain('127.0.0.1:11434');
    expect((err as Error).message).toContain('ECONNREFUSED');
  });

  it('deferralDetail returns the reason for the outage, so the loops defer instead of counting an attempt', async () => {
    const err = await callOllama('x', { fetchImpl: (async () => { throw refused(); }) as any }).catch((e) => e);
    expect(deferralDetail(err)).toContain('127.0.0.1:11434');
  });
});

// A fetch that rejects the way Node's fetch does, with the given cause.
const rejectWith = (cause: unknown, message = 'fetch failed') =>
  (async () => { throw Object.assign(new TypeError(message), { cause }); }) as any;

describe('callOllama: only a connection error code is an outage', () => {
  for (const code of ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT']) {
    it(`${code} is an outage`, async () => {
      const err = await callOllama('x', { fetchImpl: rejectWith(Object.assign(new Error(`e ${code}`), { code })) }).catch((e) => e);
      expect(err).toBeInstanceOf(OllamaUnavailableError);
    });
  }

  it('reads the code from the error itself when it has no cause', async () => {
    const fetchImpl = (async () => { throw Object.assign(new Error('getaddrinfo ENOTFOUND x'), { code: 'ENOTFOUND' }); }) as any;
    expect(await callOllama('x', { fetchImpl }).catch((e) => e)).toBeInstanceOf(OllamaUnavailableError);
  });

  it('an AggregateError of a dual-stack localhost is an outage, and the reason names the code', async () => {
    const cause = new AggregateError([
      Object.assign(new Error('connect ECONNREFUSED ::1:11434'), { code: 'ECONNREFUSED' }),
      Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:11434'), { code: 'ECONNREFUSED' }),
    ], '');
    const err = await callOllama('x', { fetchImpl: rejectWith(cause) }).catch((e) => e);
    expect(err).toBeInstanceOf(OllamaUnavailableError);
    expect((err as Error).message).toMatch(/unreachable: \S/);
    expect((err as Error).message).toContain('ECONNREFUSED');
  });

  for (const code of ['UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'ERR_TLS_CERT_ALTNAME_INVALID']) {
    it(`${code} stays a counted failure and rethrows the original error`, async () => {
      const original = Object.assign(new TypeError('fetch failed'), { cause: Object.assign(new Error('other'), { code }) });
      const err = await callOllama('x', { fetchImpl: (async () => { throw original; }) as any }).catch((e) => e);
      expect(err).toBe(original);
      expect(deferralDetail(err)).toBeNull();
    });
  }

  it('a rejection with no code stays a counted failure', async () => {
    const err = await callOllama('x', { fetchImpl: rejectWith(new Error('no code')) }).catch((e) => e);
    expect(err).not.toBeInstanceOf(OllamaUnavailableError);
  });

  it('decides abort by the signal, not by the error name', async () => {
    // An AbortError name without an aborted signal, with a connection code: an outage.
    const fetchImpl = (async () => {
      throw Object.assign(new Error('x'), { name: 'AbortError', cause: Object.assign(new Error('c'), { code: 'ECONNREFUSED' }) });
    }) as any;
    expect(await callOllama('x', { fetchImpl }).catch((e) => e)).toBeInstanceOf(OllamaUnavailableError);
  });
});

describe('callOllama: the other failures stay counted failures', () => {
  it('a timeout is a plain error, not an outage', async () => {
    const err = await callOllama('x', { fetchImpl: hangingFetch, timeoutMs: 5 }).catch((e) => e);
    expect((err as Error).message).toMatch(/timed out/);
    expect((err as Error).name).not.toBe('OllamaUnavailableError');
    expect(deferralDetail(err)).toBeNull();
  });

  it('an HTTP 500 is a plain error, not an outage (the failing-model contract)', async () => {
    const err = await callOllama('x', { fetchImpl: httpStatus(500) }).catch((e) => e);
    expect((err as Error).message).toMatch(/HTTP 500/);
    expect((err as Error).name).not.toBe('OllamaUnavailableError');
  });

  it('an empty reply is a plain error', async () => {
    const fetchImpl = (async () => ({ ok: true, status: 200, json: async () => ({ response: '  ' }) })) as any;
    const err = await callOllama('x', { fetchImpl }).catch((e) => e);
    expect((err as Error).message).toMatch(/empty/);
    expect((err as Error).name).not.toBe('OllamaUnavailableError');
  });
});

describe('summarizeConversation: an outage stops the summary without a stored failure', () => {
  it('a refused connection on the sync path defers: no attempt, no failure record, no empty summary', async () => {
    process.env.EPISODIC_MEMORY_SUMMARIZER_BACKEND = 'ollama';
    process.env.EPISODIC_MEMORY_MAX_SUMMARY_ATTEMPTS = '1';
    const testDir = mkdtempSync(join(tmpdir(), 'em-ollama-outage-'));
    try {
      const sourceDir = join(testDir, 'source');
      const destDir = join(testDir, 'dest');
      const id = '7777aaaa-7777-7777-7777-777777777777';
      mkdirSync(join(sourceDir, 'proj'), { recursive: true });
      const line = (type: string, uuid: string, parent: string | null, content: string) => JSON.stringify({
        type, uuid, parentUuid: parent, timestamp: '2025-10-01T13:00:00Z', isSidechain: false,
        message: { role: type, content },
      });
      writeFileSync(
        join(sourceDir, 'proj', `${id}.jsonl`),
        line('user', 'u1', null, 'A real question about the cache store, with enough text to summarize.') + '\n' +
          line('assistant', 'a1', 'u1', 'A substantive answer that explains the sqlite choice in some detail.'),
        'utf-8'
      );
      process.env.FLEET_GPU_RESERVATION = join(testDir, 'no-reservation.json');
      vi.stubGlobal('fetch', vi.fn(async () => { throw refused(); }));

      const result = await syncConversations(sourceDir, destDir, { skipIndex: true });

      expect(result.errors).toEqual([]);
      expect(result.summariesDeferred).toContain('127.0.0.1:11434');
      expect(existsSync(join(destDir, 'proj', `${id}-summary.txt`))).toBe(false);
      expect(existsSync(join(destDir, 'proj', `${id}-summary.failed`))).toBe(false);
    } finally {
      safeRmSync(testDir);
    }
  });
});
