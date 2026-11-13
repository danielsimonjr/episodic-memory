import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

describe('allowScripts declaration for native modules', () => {
  // A name-only `false` entry tells npm to skip the install script of the named package. npm 11.20
  // skips a denied script. npm 11.20 still runs an unlisted script with a notice. The onnxruntime-node
  // postinstall installs nothing on win32 and darwin. On linux/x64, the postinstall downloads the
  // CUDA 12 provider files (a NuGet package of about 236 MB). The plugin runs on the CPU only.
  it('denies the install scripts that the plugin does not need', () => {
    expect(pkg.allowScripts['onnxruntime-node']).toBe(false);
  });
});
