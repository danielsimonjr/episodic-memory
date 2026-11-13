import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';
import { PassThrough, Writable } from 'stream';

// A write to the stdin of a child that has exited does not throw. The write fails later.
// The stream emits an 'error' event with EPIPE. Without a listener, the event is an uncaught exception.
// The uncaught exception stops a sync, a summary run or `doctor`. A real child cannot close its end of the pipe on cue, so a fake child fails each write after the
// `initialize` answer, as a closed pipe does.
const { spawnMock } = vi.hoisted(() => ({ spawnMock: vi.fn() }));
vi.mock('child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof import('child_process')>()),
  spawn: spawnMock,
}));

const { runCodexCommand } = await import('../src/summarizer.js');
const { detectCodexHookTrustState } = await import('../src/codex-hook-trust.js');

interface FakeChild extends EventEmitter {
  stdin: Writable;
  stdout: PassThrough;
  stderr: PassThrough;
  killed: boolean;
  kill: () => boolean;
}

/** A child that answers `initialize`. Each later write fails with EPIPE, or the child exits, as `after` says. */
function fakeAppServer(after: 'epipe' | 'exit'): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    return true;
  };
  child.stdin = new Writable({
    write(chunk, _encoding, callback) {
      const message = JSON.parse(chunk.toString());
      if (message.method === 'initialize') {
        setImmediate(() => {
          child.stdout.write(JSON.stringify({ id: message.id, result: {} }) + '\n');
          if (after === 'exit') setImmediate(() => child.emit('exit', 0, null));
        });
        callback();
        return;
      }
      if (after === 'epipe') {
        callback(Object.assign(new Error('write EPIPE'), { code: 'EPIPE', errno: -4047, syscall: 'write' }));
        return;
      }
      callback();
    },
  });
  return child;
}

describe('an app-server client when the stdin pipe of the child breaks', () => {
  const uncaught: unknown[] = [];
  const onUncaught = (error: unknown) => uncaught.push(error);
  const savedTimeout = process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS;

  beforeEach(() => {
    uncaught.length = 0;
    process.on('uncaughtException', onUncaught);
    // Without the fix, the summary call waits for this timeout. The test then sees the timeout message.
    process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS = '3000';
    spawnMock.mockReset();
  });

  afterEach(() => {
    process.off('uncaughtException', onUncaught);
    if (savedTimeout === undefined) delete process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS;
    else process.env.EPISODIC_MEMORY_CODEX_SUMMARY_TIMEOUT_MS = savedTimeout;
  });

  it('runCodexCommand rejects with the EPIPE error and raises no uncaught exception', async () => {
    const child = fakeAppServer('epipe');
    spawnMock.mockReturnValue(child);
    await expect(runCodexCommand({
      command: 'codex',
      args: ['app-server'],
      sessionId: 'session-123',
      prompt: 'Summarize this conversation.',
      skipVersionCheck: true,
    })).rejects.toThrow(/EPIPE/);
    // The stream emits the error on a later tick. Wait one tick, so that a missing listener shows here.
    await new Promise(resolve => setImmediate(resolve));
    expect(uncaught).toEqual([]);
    expect(child.killed).toBe(true);
  });

  it('detectCodexHookTrustState returns unknown at once and raises no uncaught exception', async () => {
    spawnMock.mockReturnValue(fakeAppServer('epipe'));
    const started = Date.now();
    await expect(detectCodexHookTrustState('/codex-home', process.cwd(), 3000)).resolves.toBe('unknown');
    await new Promise(resolve => setImmediate(resolve));
    expect(uncaught).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1500);
  });

  it('detectCodexHookTrustState returns unknown at once when the app-server exits early', async () => {
    spawnMock.mockReturnValue(fakeAppServer('exit'));
    const started = Date.now();
    await expect(detectCodexHookTrustState('/codex-home', process.cwd(), 3000)).resolves.toBe('unknown');
    expect(Date.now() - started).toBeLessThan(1500);
  });
});
