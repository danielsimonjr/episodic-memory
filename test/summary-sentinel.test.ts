import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { writeNoExchangeSummary } from '../src/summary-sentinel.js';
import { safeRmSync } from './test-utils.js';

describe('writeNoExchangeSummary', () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'em-sentinel-')); });
  afterEach(() => safeRmSync(dir));

  it('writes an empty summary and a no-exchanges failure record beside the transcript', () => {
    const archive = join(dir, 'abc.jsonl');
    writeNoExchangeSummary(archive);
    expect(readFileSync(join(dir, 'abc-summary.txt'), 'utf-8')).toBe('');
    const failed = JSON.parse(readFileSync(join(dir, 'abc-summary.failed'), 'utf-8'));
    expect(failed.reason).toBe('no-exchanges');
    expect(Number.isNaN(Date.parse(failed.recordedAt))).toBe(false);
  });
});
