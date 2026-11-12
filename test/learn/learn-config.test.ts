import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { learnEnabled, learnConfig } from '../../src/learn/learn-config.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '..', 'src', 'learn', 'learn-config.ts');

const PREFIX = 'EPISODIC_MEMORY_LEARN';

let saved: Record<string, string | undefined> = {};

function clearLearnEnv(): void {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(PREFIX)) delete process.env[key];
  }
}

beforeEach(() => {
  saved = { ...process.env };
  clearLearnEnv();
});

afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith(PREFIX)) delete process.env[key];
  }
  for (const [key, value] of Object.entries(saved)) {
    if (!key.startsWith(PREFIX)) continue;
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('learnEnabled', () => {
  it('is off when the variable is absent', () => {
    expect(learnEnabled()).toBe(false);
  });

  it('is on for 1, true, yes and on', () => {
    for (const value of ['1', 'true', 'yes', 'on', 'TRUE', ' Yes ']) {
      process.env.EPISODIC_MEMORY_LEARN = value;
      expect(learnEnabled(), value).toBe(true);
    }
  });

  it('stays off for 0, false, no and an empty string', () => {
    for (const value of ['0', 'false', 'no', '', 'off']) {
      process.env.EPISODIC_MEMORY_LEARN = value;
      expect(learnEnabled(), value).toBe(false);
    }
  });
});

describe('learnConfig defaults', () => {
  it('returns every Global Constraints default with no env set', () => {
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
      pidPollMs: 1000,
    });
  });
});

describe('learnConfig parsing', () => {
  it('reads the model from EPISODIC_MEMORY_LEARN_MODEL', () => {
    process.env.EPISODIC_MEMORY_LEARN_MODEL = 'opus';
    expect(learnConfig().model).toBe('opus');
  });

  it('ignores a blank model name', () => {
    process.env.EPISODIC_MEMORY_LEARN_MODEL = '   ';
    expect(learnConfig().model).toBe('sonnet');
  });

  it('accepts each approve enum value', () => {
    for (const value of ['instructions', 'all', 'none'] as const) {
      process.env.EPISODIC_MEMORY_LEARN_APPROVE = value;
      expect(learnConfig().approve).toBe(value);
    }
  });

  it('falls back to instructions for an unknown approve value', () => {
    process.env.EPISODIC_MEMORY_LEARN_APPROVE = 'sometimes';
    expect(learnConfig().approve).toBe('instructions');
  });

  it('reads every numeric setting from its own variable', () => {
    const cases: Array<[string, number, keyof ReturnType<typeof learnConfig>]> = [
      ['MAX_CALLS', 17, 'maxCalls'],
      ['MAX_USD', 2.5, 'maxUsd'],
      ['MAX_MINUTES', 7, 'maxMinutes'],
      ['MAX_TASKS', 33, 'maxTasks'],
      ['CONCURRENCY', 9, 'concurrency'],
      ['ROUNDS', 4, 'rounds'],
      ['MIN_SAVING', 25, 'minSavingPct'],
      ['MIN_GROUNDING', 6, 'minGrounding'],
      ['SOLVER_MAX_TURNS', 5, 'solverMaxTurns'],
      ['LEARNER_MAX_TURNS', 41, 'learnerMaxTurns'],
      ['MAX_CHARS', 900, 'maxChars'],
      ['LEAF_MAX', 2, 'leafMax'],
      ['EDITS_PER_ROUND', 8, 'editsPerRound'],
      ['VALIDATE_SAMPLE', 11, 'validateSample'],
      ['PID_POLL_MS', 750, 'pidPollMs'],
    ];
    for (const [suffix, value, field] of cases) {
      clearLearnEnv();
      process.env[`${PREFIX}_${suffix}`] = String(value);
      expect(learnConfig()[field], suffix).toBe(value);
    }
  });

  it('ignores zero, a negative number and a non-number', () => {
    for (const raw of ['0', '-4', 'abc', '', ' ', 'NaN', 'Infinity']) {
      clearLearnEnv();
      process.env.EPISODIC_MEMORY_LEARN_MAX_CALLS = raw;
      process.env.EPISODIC_MEMORY_LEARN_MIN_GROUNDING = raw;
      const config = learnConfig();
      expect(config.maxCalls, raw).toBe(200);
      expect(config.minGrounding, raw).toBe(3);
    }
  });

  it('ignores a fractional value for a count', () => {
    process.env.EPISODIC_MEMORY_LEARN_MAX_TASKS = '2.5';
    expect(learnConfig().maxTasks).toBe(120);
  });

  it('accepts a fractional USD budget', () => {
    process.env.EPISODIC_MEMORY_LEARN_MAX_USD = '0.75';
    expect(learnConfig().maxUsd).toBe(0.75);
  });
});

describe('learn-config module shape', () => {
  it('imports nothing, so the digest hook can load it on its fast path', () => {
    const source = fs.readFileSync(SRC, 'utf8');
    expect(source).not.toMatch(/^\s*import\s/m);
    expect(source).not.toMatch(/\brequire\s*\(/);
    expect(source).not.toMatch(/\bimport\s*\(/);
  });
});
