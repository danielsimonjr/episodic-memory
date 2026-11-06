import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { learnConfig, learnEnabled } from '../../src/learn/learn-config.js';

const KEYS = [
  'EPISODIC_MEMORY_LEARN',
  'EPISODIC_MEMORY_LEARN_MODEL',
  'EPISODIC_MEMORY_LEARN_APPROVE',
  'EPISODIC_MEMORY_LEARN_MAX_CALLS',
  'EPISODIC_MEMORY_LEARN_MAX_USD',
  'EPISODIC_MEMORY_LEARN_MAX_MINUTES',
  'EPISODIC_MEMORY_LEARN_MAX_TASKS',
  'EPISODIC_MEMORY_LEARN_CONCURRENCY',
  'EPISODIC_MEMORY_LEARN_ROUNDS',
  'EPISODIC_MEMORY_LEARN_MIN_SAVING',
  'EPISODIC_MEMORY_LEARN_MIN_GROUNDING',
  'EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS',
  'EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS',
  'EPISODIC_MEMORY_LEARN_MAX_CHARS',
  'EPISODIC_MEMORY_LEARN_LEAF_MAX',
  'EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND',
  'EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE',
];

describe('learn config', () => {
  const saved = new Map<string, string | undefined>();

  beforeEach(() => {
    for (const key of KEYS) {
      saved.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      const value = saved.get(key);
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    saved.clear();
  });

  it('defaults the flag to off', () => {
    expect(learnEnabled()).toBe(false);
  });

  it('turns the flag on for 1, true and yes only', () => {
    for (const on of ['1', 'true', 'yes', 'on', ' TRUE ']) {
      process.env.EPISODIC_MEMORY_LEARN = on;
      expect(learnEnabled()).toBe(true);
    }
    for (const off of ['0', 'false', '', 'no', 'off', 'maybe']) {
      process.env.EPISODIC_MEMORY_LEARN = off;
      expect(learnEnabled()).toBe(false);
    }
  });

  it('returns every documented default', () => {
    expect(learnConfig()).toEqual({
      model: 'sonnet',
      approve: 'instructions',
      maxCalls: 200,
      maxUsd: 5,
      maxMinutes: 60,
      maxTasks: 120,
      concurrency: 3,
      rounds: 3,
      minSavingPct: 10,
      minGrounding: 3,
      solverMaxTurns: 12,
      learnerMaxTurns: 30,
      maxChars: 2500,
      leafMax: 12,
      editsPerRound: 3,
      validateSample: 5,
    });
  });

  it('reads each numeric budget from its own variable', () => {
    process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '7';
    process.env.EPISODIC_MEMORY_LEARN_MAX_USD = '1.5';
    process.env.EPISODIC_MEMORY_LEARN_MAX_MINUTES = '9';
    process.env.EPISODIC_MEMORY_LEARN_MAX_TASKS = '11';
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = '2';
    process.env.EPISODIC_MEMORY_LEARN_ROUNDS = '4';
    process.env.EPISODIC_MEMORY_LEARN_MIN_SAVING = '25';
    process.env.EPISODIC_MEMORY_LEARN_MIN_GROUNDING = '6';
    process.env.EPISODIC_MEMORY_LEARN_SOLVER_MAX_TURNS = '5';
    process.env.EPISODIC_MEMORY_LEARN_LEARNER_MAX_TURNS = '40';
    process.env.EPISODIC_MEMORY_LEARN_MAX_CHARS = '100';
    process.env.EPISODIC_MEMORY_LEARN_LEAF_MAX = '4';
    process.env.EPISODIC_MEMORY_LEARN_EDITS_PER_ROUND = '1';
    process.env.EPISODIC_MEMORY_LEARN_VALIDATE_SAMPLE = '9';

    expect(learnConfig()).toMatchObject({
      maxCalls: 7,
      maxUsd: 1.5,
      maxMinutes: 9,
      maxTasks: 11,
      concurrency: 2,
      rounds: 4,
      minSavingPct: 25,
      minGrounding: 6,
      solverMaxTurns: 5,
      learnerMaxTurns: 40,
      maxChars: 100,
      leafMax: 4,
      editsPerRound: 1,
      validateSample: 9,
    });
  });

  it('ignores a non-positive or non-numeric budget', () => {
    process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = '0';
    process.env.EPISODIC_MEMORY_LEARN_MAX_USD = '-2';
    process.env.EPISODIC_MEMORY_LEARN_MAX_MINUTES = 'lots';
    process.env.EPISODIC_MEMORY_LEARN_MAX_TASKS = '';
    process.env.EPISODIC_MEMORY_LEARN_CONCURRENCY = 'NaN';
    process.env.EPISODIC_MEMORY_LEARN_ROUNDS = 'Infinity';

    const config = learnConfig();
    expect(config.maxCalls).toBe(200);
    expect(config.maxUsd).toBe(5);
    expect(config.maxMinutes).toBe(60);
    expect(config.maxTasks).toBe(120);
    expect(config.concurrency).toBe(3);
    expect(config.rounds).toBe(3);
  });

  it('reads the model name', () => {
    process.env.EPISODIC_MEMORY_LEARN_MODEL = 'opus';
    expect(learnConfig().model).toBe('opus');
    process.env.EPISODIC_MEMORY_LEARN_MODEL = '   ';
    expect(learnConfig().model).toBe('sonnet');
  });

  it('accepts only the approval enum and defaults to instructions', () => {
    for (const mode of ['instructions', 'all', 'none'] as const) {
      process.env.EPISODIC_MEMORY_LEARN_APPROVE = mode;
      expect(learnConfig().approve).toBe(mode);
    }
    for (const bad of ['', 'ALL', 'some', 'true']) {
      process.env.EPISODIC_MEMORY_LEARN_APPROVE = bad;
      expect(learnConfig().approve).toBe('instructions');
    }
  });

  it('imports nothing: the hook depends on a dependency-free module', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const url = await import('node:url');
    const here = path.dirname(url.fileURLToPath(import.meta.url));
    const source = fs.readFileSync(path.join(here, '..', '..', 'src', 'learn', 'learn-config.ts'), 'utf8');
    expect(source.match(/^\s*import\b/gm)).toBeNull();
    expect(source).not.toMatch(/\brequire\(/);
  });
});
