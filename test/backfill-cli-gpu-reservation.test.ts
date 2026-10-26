import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawnSync } from 'child_process';
import { existsSync, mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { safeRmSync } from './test-utils.js';
import { SUMMARIZER_GUARD_ENV } from '../src/reentrancy.js';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BACKFILL_CLI = join(REPO_ROOT, 'dist', 'backfill-cli.js');

let root: string;
let transcript: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'em-backfill-cli-gpu-'));
  const project = join(root, 'conversation-archive', 'p');
  mkdirSync(project, { recursive: true });
  transcript = join(project, '00000001-cccc-4ccc-8ccc-cccccccccccc.jsonl');
  writeFileSync(
    transcript,
    JSON.stringify({ type: 'user', uuid: 'u', parentUuid: null, timestamp: '2025-10-01T13:00:00Z', isSidechain: false, message: { role: 'user', content: 'A real question with enough substance to summarize here.' } }) + '\n' +
      JSON.stringify({ type: 'assistant', uuid: 'a', parentUuid: 'u', timestamp: '2025-10-01T13:00:01Z', isSidechain: false, message: { role: 'assistant', content: 'A real substantive answer to that question.' } }),
    'utf-8'
  );
});
afterEach(() => safeRmSync(root));

describe('backfill CLI under a GPU reservation', () => {
  it('pauses, says why, writes nothing and exits 0', () => {
    const reservation = join(root, 'gpu-reserved.json');
    writeFileSync(reservation, JSON.stringify({ holder: 'Starship' }));
    const env: Record<string, string | undefined> = {
      ...process.env,
      EPISODIC_MEMORY_CONFIG_DIR: root,
      FLEET_GPU_RESERVATION: reservation,
      EPISODIC_MEMORY_SUMMARIZER_BACKEND: 'ollama',
      EPISODIC_MEMORY_OLLAMA_URL: 'http://127.0.0.1:9', // closed port: no run of this test can reach a model
    };
    delete env[SUMMARIZER_GUARD_ENV];

    const run = spawnSync(process.execPath, [BACKFILL_CLI], { env, encoding: 'utf-8', timeout: 30000 });

    expect(run.status).toBe(0);
    expect(run.stdout).toContain('Backfill paused: fleet GPU reserved by Starship. Run it again when the GPU is free.');
    expect(run.stdout).toContain('Backfill finished: 0 processed, 0 summarized, 0 errors');
    expect(existsSync(transcript.replace('.jsonl', '-summary.txt'))).toBe(false);
    expect(existsSync(transcript.replace('.jsonl', '-summary.failed'))).toBe(false);
  });
});
