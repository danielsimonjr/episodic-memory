import { describe, it, expect } from 'vitest';
import { tmpdir } from 'node:os';
import { TEST_ENV } from './test-env.js';

describe('test environment', () => {
  it('carries no EPISODIC_MEMORY_* setting from the machine that runs the suite', () => {
    const leaked = Object.keys(process.env).filter(
      key => key.startsWith('EPISODIC_MEMORY_') && !(key in TEST_ENV)
    );
    // A machine setting such as EPISODIC_MEMORY_OLLAMA_FALLBACK_MODEL sends a test to a live model.
    expect(leaked).toEqual([]);
  });

  it('pins every TEST_ENV value', () => {
    for (const [key, value] of Object.entries(TEST_ENV)) {
      expect(process.env[key], key).toBe(value);
    }
  });

  it('points the config directory away from the live data', () => {
    expect(process.env.EPISODIC_MEMORY_CONFIG_DIR?.startsWith(tmpdir())).toBe(true);
  });
});
