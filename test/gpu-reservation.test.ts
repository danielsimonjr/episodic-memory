import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { join } from 'path';
import { gpuReservationBlock, readGpuReservation, reservationPath } from '../src/gpu-reservation.js';
import { GpuReservedError, callOllama } from '../src/ollama-backend.js';
import { safeRmSync } from './test-utils.js';

const KEYS = ['FLEET_GPU_RESERVATION', 'EPISODIC_MEMORY_OLLAMA_URL', 'EPISODIC_MEMORY_OLLAMA_MODEL'];
const saved: Record<string, string | undefined> = {};
for (const k of KEYS) saved[k] = process.env[k];

let dir: string;
let file: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'em-gpu-'));
  file = join(dir, 'gpu-reserved.json');
  process.env.FLEET_GPU_RESERVATION = file;
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  safeRmSync(dir);
});

describe('reservationPath', () => {
  it('uses FLEET_GPU_RESERVATION when it is set', () => {
    expect(reservationPath()).toBe(file);
  });

  it('defaults to the fleet file under the home directory', () => {
    delete process.env.FLEET_GPU_RESERVATION;
    expect(reservationPath()).toBe(join(homedir(), 'Dropbox', '_fleet', 'gpu-reserved.json'));
  });
});

describe('readGpuReservation', () => {
  it('counts a missing file as free, because the fleet releases by renaming the file', () => {
    expect(readGpuReservation()).toBeNull();
  });

  it('returns the holder and the informational fields of a held reservation', () => {
    writeFileSync(
      file,
      JSON.stringify({ holder: 'Starship', why: 'benchmark', since: '2026-10-26T00:00:16-05:00', expected_end: '2026-10-26T07:30:00-05:00' }),
    );
    expect(readGpuReservation()).toEqual({
      holder: 'Starship',
      why: 'benchmark',
      since: '2026-10-26T00:00:16-05:00',
      expectedEnd: '2026-10-26T07:30:00-05:00',
    });
  });

  it.each([
    ['an object with no holder', '{}'],
    ['an empty holder', '{"holder":""}'],
    ['a holder that is not a string', '{"holder":7}'],
    ['a JSON array', '[]'],
    ['a JSON number', '7'],
    ['a JSON string', '"x"'],
  ])('counts a file with %s as free, because it names nobody', (_label, body) => {
    writeFileSync(file, body);
    expect(readGpuReservation()).toBeNull();
  });

  it('counts a file that is not valid JSON as reserved', () => {
    writeFileSync(file, '{"holder": "Star');
    expect(readGpuReservation()).toMatchObject({ holder: 'unknown' });
  });

  it('counts the text null as reserved, because the other readers of the file do', () => {
    // JSON.parse('null') succeeds. A reader that only looks for a holder would call it free.
    writeFileSync(file, 'null');
    expect(readGpuReservation()).toMatchObject({ holder: 'unknown' });
  });

  it('counts a file that cannot be read as reserved', () => {
    mkdirSync(file); // reading a directory fails with EISDIR, not ENOENT
    expect(readGpuReservation()).toMatchObject({ holder: 'unknown' });
  });
});

describe('gpuReservationBlock', () => {
  it('returns null while the GPU is free', () => {
    expect(gpuReservationBlock()).toBeNull();
  });

  it('names the holder and the expected end while the GPU is reserved', () => {
    writeFileSync(file, JSON.stringify({ holder: 'Starship', expected_end: '2026-10-26T07:30:00-05:00' }));
    const message = gpuReservationBlock();
    expect(message).toContain('Starship');
    expect(message).toContain('2026-10-26T07:30:00-05:00');
  });

  it('keeps the path out of the message when a holder is named', () => {
    writeFileSync(file, JSON.stringify({ holder: 'Starship' }));
    expect(gpuReservationBlock()).toBe('fleet GPU reserved by Starship');
  });

  it.each([
    ['a file that is not valid JSON', () => writeFileSync(file, '{"holder": "Star'), 'not valid JSON'],
    ['the text null', () => writeFileSync(file, 'null'), 'not valid JSON'],
    ['a file that cannot be read', () => mkdirSync(file), 'unreadable'],
  ])('names the cause and the path for %s, so a stale file can be found', (_label, setup, cause) => {
    setup();
    const message = gpuReservationBlock();
    expect(message).toContain('reserved by unknown');
    expect(message).toContain(cause);
    expect(message).toContain(file);
  });
});

describe('GpuReservedError', () => {
  it('keeps the reservation message as detail, so a caller can report it without the prefix', () => {
    const error = new GpuReservedError('fleet GPU reserved by Starship');
    expect(error.detail).toBe('fleet GPU reserved by Starship');
    expect(error.message).toContain('fleet GPU reserved by Starship');
    expect(error.name).toBe('GpuReservedError');
  });
});

describe('callOllama under a reservation', () => {
  const okFetch = () =>
    vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ response: '<summary>x</summary>' }) }) as any);

  beforeEach(() => {
    process.env.EPISODIC_MEMORY_OLLAMA_URL = 'http://127.0.0.1:11434';
    process.env.EPISODIC_MEMORY_OLLAMA_MODEL = 'qwen3.8:27b';
  });

  it('throws GpuReservedError and sends no request while the GPU is reserved', async () => {
    writeFileSync(file, JSON.stringify({ holder: 'Starship' }));
    const fetchImpl = okFetch();
    const call = callOllama('hello', { fetchImpl: fetchImpl as any });
    await expect(call).rejects.toBeInstanceOf(GpuReservedError);
    await expect(call).rejects.toThrow(/Starship/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('sends the request when the GPU is free', async () => {
    const fetchImpl = okFetch();
    await expect(callOllama('hello', { fetchImpl: fetchImpl as any })).resolves.toBe('<summary>x</summary>');
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
