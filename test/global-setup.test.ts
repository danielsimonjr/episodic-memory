import { describe, it, expect } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { env } from '@huggingface/transformers';
import config from '../vitest.config.js';

describe('vitest global setup', () => {
  it('loads the embedding model once before the workers start', () => {
    // Without the global setup, every worker of a fresh checkout downloads the model at the same
    // time. On Windows, the rename of the temporary model file fails with EPERM.
    const globalSetup = config.test?.globalSetup;
    const files = Array.isArray(globalSetup) ? globalSetup : [globalSetup];
    expect(files).toContain('test/global-setup.ts');
  });

  it('leaves the model file in the cache that the workers read', () => {
    const cacheDir = env.cacheDir;
    expect(cacheDir, 'transformers cacheDir').toBeTruthy();
    const model = join(String(cacheDir), 'Xenova', 'bge-small-en-v1.5', 'onnx', 'model_quantized.onnx');
    expect(existsSync(model), model).toBe(true);
  });
});
