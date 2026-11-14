import { describe, it, expect } from 'vitest';
import { modelDir, modelState } from '../src/embedding-model.js';
import config from '../vitest.config.js';

describe('vitest global setup', () => {
  it('loads the embedding model once before the workers start', () => {
    // Without the global setup, every worker of a fresh checkout downloads the model at the same
    // time. On Windows, the rename of the temporary model file fails with EPERM.
    const globalSetup = config.test?.globalSetup;
    const files = Array.isArray(globalSetup) ? globalSetup : [globalSetup];
    expect(files).toContain('test/global-setup.ts');
  });

  it('leaves a ready model in the folder that the workers read', () => {
    expect(modelDir()).toBe(process.env.EPISODIC_MEMORY_MODEL_DIR);
    expect(modelState()).toEqual({ state: 'ready', bad: [] });
  });
});
