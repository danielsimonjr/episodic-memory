import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  EMBEDDING_MODEL,
  ensureModel,
  fetchModelForSync,
  FETCH_FAILED_MARKER,
  modelDir,
  modelState,
  type ModelSpec,
} from '../src/embedding-model.js';
import { EmbeddingsUnavailableError } from '../src/embeddings.js';
import { safeRmSync } from './test-utils.js';

const sha = (b: Buffer | string) => createHash('sha256').update(b).digest('hex');

// Small stand-in files. The 34 MB model is not needed to test the fetch, the hash check and the rename.
const FILES: Record<string, string> = {
  'tokenizer.json': '{"stand-in":"tokenizer"}',
  'onnx/model_quantized.onnx': 'stand-in model bytes',
};
const SPEC: ModelSpec = {
  repo: 'test/stand-in',
  revision: '0123456789abcdef0123456789abcdef01234567',
  files: Object.entries(FILES).map(([path, body]) => ({ path, size: Buffer.byteLength(body), sha256: sha(body) })),
};

let dir: string;
let server: Server;
let endpoint: string;
let requests: string[];
let serve: Record<string, string>;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'em-model-'));
  requests = [];
  serve = { ...FILES };
  server = createServer((req, res) => {
    requests.push(req.url ?? '');
    const prefix = `/${SPEC.repo}/resolve/${SPEC.revision}/`;
    const file = (req.url ?? '').startsWith(prefix) ? decodeURIComponent((req.url ?? '').slice(prefix.length)) : '';
    if (!(file in serve)) { res.statusCode = 404; res.end(); return; }
    res.end(serve[file]);
  });
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(async () => {
  delete process.env.EPISODIC_MEMORY_MODEL_OFFLINE;
  await new Promise<void>(r => server.close(() => r()));
  safeRmSync(dir);
});

function writeGood(): void {
  for (const [path, body] of Object.entries(FILES)) {
    mkdirSync(join(dir, path, '..'), { recursive: true });
    writeFileSync(join(dir, path), body);
  }
}

const leftovers = () => readdirSync(dir, { recursive: true }).map(String).filter(n => n.includes('.tmp-'));

describe('EMBEDDING_MODEL', () => {
  it('pins the bge-small-en-v1.5 revision and the hashes of its three files', () => {
    expect(EMBEDDING_MODEL.repo).toBe('Xenova/bge-small-en-v1.5');
    expect(EMBEDDING_MODEL.revision).toBe('ea104dacec62c0de699686887e3f920caeb4f3e3');
    expect(EMBEDDING_MODEL.files).toEqual([
      { path: 'tokenizer.json', size: 711396, sha256: 'd241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66' },
      { path: 'tokenizer_config.json', size: 366, sha256: '9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3' },
      { path: 'onnx/model_quantized.onnx', size: 34014426, sha256: '6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4' },
    ]);
  });

  it('keeps the model in EPISODIC_MEMORY_MODEL_DIR when the variable is set', () => {
    const saved = process.env.EPISODIC_MEMORY_MODEL_DIR;
    process.env.EPISODIC_MEMORY_MODEL_DIR = dir;
    try { expect(modelDir()).toBe(dir); } finally { process.env.EPISODIC_MEMORY_MODEL_DIR = saved; }
  });

  it('keeps the model outside node_modules by default', () => {
    const saved = process.env.EPISODIC_MEMORY_MODEL_DIR;
    delete process.env.EPISODIC_MEMORY_MODEL_DIR;
    try {
      expect(modelDir()).not.toMatch(/node_modules/);
      expect(modelDir()).toContain(EMBEDDING_MODEL.revision);
    } finally { process.env.EPISODIC_MEMORY_MODEL_DIR = saved; }
  });
});

describe('modelState', () => {
  it('reports ready when every file has the pinned size and hash', () => {
    writeGood();
    expect(modelState({ spec: SPEC, dir })).toEqual({ state: 'ready', bad: [] });
  });

  it('reports a file that cannot be read as bad and does not throw', () => {
    // A folder at the path of a file stands in for a file that another process removes or locks
    // between the stat and the read.
    const spec: ModelSpec = { repo: SPEC.repo, revision: SPEC.revision, files: [{ path: 'empty.bin', size: 0, sha256: sha('') }] };
    mkdirSync(join(dir, 'empty.bin'));
    expect(modelState({ spec, dir })).toEqual({ state: 'missing', bad: ['empty.bin'] });
  });

  it('names each missing or changed file', () => {
    writeGood();
    writeFileSync(join(dir, 'tokenizer.json'), 'changed');
    safeRmSync(join(dir, 'onnx'));
    expect(modelState({ spec: SPEC, dir })).toEqual({ state: 'missing', bad: ['tokenizer.json', 'onnx/model_quantized.onnx'] });
  });
});

describe('ensureModel', () => {
  it('downloads each missing file and checks its hash', async () => {
    await ensureModel({ download: true, spec: SPEC, dir, endpoint });
    for (const [path, body] of Object.entries(FILES)) expect(readFileSync(join(dir, path), 'utf-8')).toBe(body);
    expect(requests).toHaveLength(2);
    expect(leftovers()).toEqual([]);
  });

  it('makes no request when the folder is ready', async () => {
    writeGood();
    await ensureModel({ download: true, spec: SPEC, dir, endpoint });
    expect(requests).toEqual([]);
  });

  it('rejects a file with a wrong hash and leaves no file at the final path', async () => {
    serve['tokenizer.json'] = '{"stand-in":"tampered"}';
    await expect(ensureModel({ download: true, spec: SPEC, dir, endpoint })).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(existsSync(join(dir, 'tokenizer.json'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('fails loudly without a download when download is false', async () => {
    const err = await ensureModel({ download: false, spec: SPEC, dir, endpoint }).catch(e => e);
    expect(err).toBeInstanceOf(EmbeddingsUnavailableError);
    expect(err.message).toContain(join(dir, 'tokenizer.json'));
    expect(err.message).toContain(SPEC.files[0].sha256);
    expect(err.message).toContain('episodic-memory model fetch');
    expect(requests).toEqual([]);
  });

  it('makes no request when EPISODIC_MEMORY_MODEL_OFFLINE is 1', async () => {
    process.env.EPISODIC_MEMORY_MODEL_OFFLINE = '1';
    await expect(ensureModel({ download: true, spec: SPEC, dir, endpoint })).rejects.toBeInstanceOf(EmbeddingsUnavailableError);
    expect(requests).toEqual([]);
  });

  it('removes a temporary file that a killed process left more than one hour ago', async () => {
    mkdirSync(join(dir, 'onnx'), { recursive: true });
    const stale = join(dir, 'onnx', 'model_quantized.onnx.tmp-999-abc');
    writeFileSync(stale, 'partial');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, old, old);
    await ensureModel({ download: true, spec: SPEC, dir, endpoint });
    expect(existsSync(stale)).toBe(false);
  });

  it('accepts the target when the rename fails but another process already wrote the correct file', async () => {
    const rename = (_from: string, to: string) => {
      const file = SPEC.files.find(f => to.endsWith(f.path.split('/').pop()!))!;
      writeFileSync(to, FILES[file.path]);
      throw Object.assign(new Error('EPERM: busy'), { code: 'EPERM' });
    };
    await ensureModel({ download: true, spec: SPEC, dir, endpoint, rename });
    expect(modelState({ spec: SPEC, dir }).state).toBe('ready');
    expect(leftovers()).toEqual([]);
  });

  it('lets two processes fetch the same folder, and both end with a ready folder', async () => {
    const script = `
      const m = await import(${JSON.stringify(new URL('../dist/embedding-model.js', import.meta.url).href)});
      await m.ensureModel({ download: true, spec: ${JSON.stringify(SPEC)}, dir: ${JSON.stringify(dir)}, endpoint: ${JSON.stringify(endpoint)} });
      process.stdout.write(m.modelState({ spec: ${JSON.stringify(SPEC)}, dir: ${JSON.stringify(dir)} }).state);
    `;
    const run = () => new Promise<string>((resolve, reject) => {
      // The children run the built module, as a plugin host does. `bun run build` writes it.
      const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let errText = '';
      child.stdout.on('data', d => { out += d; });
      child.stderr.on('data', d => { errText += d; });
      child.on('exit', code => (code === 0 ? resolve(out) : reject(new Error(errText))));
    });
    const results = await Promise.all([run(), run()]);
    expect(results).toEqual(['ready', 'ready']);
    expect(modelState({ spec: SPEC, dir }).state).toBe('ready');
    expect(leftovers()).toEqual([]);
  }, 60000);
});

describe('fetchModelForSync', () => {
  it('writes no retry marker when EPISODIC_MEMORY_MODEL_OFFLINE turns the download off', async () => {
    const saved = process.env.EPISODIC_MEMORY_MODEL_DIR;
    process.env.EPISODIC_MEMORY_MODEL_DIR = dir;
    process.env.EPISODIC_MEMORY_MODEL_OFFLINE = '1';
    try {
      await fetchModelForSync();
      // Without a marker, the first sync after the variable is cleared downloads at once.
      expect(existsSync(join(dir, FETCH_FAILED_MARKER))).toBe(false);
    } finally { process.env.EPISODIC_MEMORY_MODEL_DIR = saved; }
  });
});
