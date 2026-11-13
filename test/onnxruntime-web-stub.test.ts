import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { createRequire } from 'module';
import { join } from 'path';

const ROOT = process.cwd();
const STUB_DIR = join(ROOT, 'vendor', 'onnxruntime-web-stub');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf-8'));
const lockText = readFileSync(join(ROOT, 'bun.lock'), 'utf-8');

// The node build of @huggingface/transformers imports onnxruntime-node and onnxruntime-common. The node
// build does not import onnxruntime-web, but the transformers package lists onnxruntime-web as a
// dependency. The override replaces the onnxruntime-web dependency with a stub inside the repo. No
// installer fetches onnxruntime-web or the 17 packages that only onnxruntime-web reaches. An override
// cannot delete a package, so the stub must exist. Nothing publishes the stub.
describe('onnxruntime-web stub override', () => {
  it('replaces onnxruntime-web with the stub inside the repo', () => {
    expect(pkg.overrides?.['onnxruntime-web']).toBe('file:./vendor/onnxruntime-web-stub');
  });

  it('keeps the stub private, named onnxruntime-web, with no dependencies', () => {
    const stub = JSON.parse(readFileSync(join(STUB_DIR, 'package.json'), 'utf-8'));
    expect(stub.name).toBe('onnxruntime-web');
    expect(stub.private).toBe(true);
    expect(stub.dependencies).toBeUndefined();
    expect(stub.optionalDependencies).toBeUndefined();
  });

  // A later transformers release can import onnxruntime-web in the node build. The stub then throws at
  // once, and the embedding tests show the failure.
  it('throws when a module loads the stub', () => {
    const load = createRequire(join(STUB_DIR, 'package.json'));
    expect(() => load('./index.js')).toThrow('onnxruntime-web is stubbed out; the node build does not use it');
  });

  it('locks onnxruntime-web to the stub and holds no registry onnxruntime-web or protobufjs', () => {
    expect(lockText).toContain('"onnxruntime-web@file:./vendor/onnxruntime-web-stub"');
    // The check names only the two packages of the onnxruntime-web closure that no other package is
    // likely to need. A generic name such as `long` can return through an unrelated dependency.
    expect(lockText, 'bun.lock resolves a registry onnxruntime-web').not.toMatch(/"onnxruntime-web@\d/);
    expect(lockText, 'bun.lock resolves protobufjs').not.toMatch(/"protobufjs": \["protobufjs@/);
  });

  // The protobufjs override set a patched floor for protobufjs, and only onnxruntime-web reached protobufjs.
  // Without onnxruntime-web, no package reaches protobufjs, so the override and the install-script deny do nothing.
  it('holds no override and no install-script entry for protobufjs', () => {
    expect(pkg.overrides?.protobufjs).toBeUndefined();
    expect(pkg.allowScripts?.protobufjs).toBeUndefined();
  });

  // The stub is safe only while the node build of transformers never imports onnxruntime-web. The
  // onnxruntime-node import is the control: a check that reads the wrong file finds neither import.
  // A pattern matches any call with the package name as its first argument, and any `from` clause.
  // transformers 4.2.0 uses `from "onnxruntime-node"`. transformers 4.3.2 uses a `createRequire`
  // function: `requireFromHere("onnxruntime-node")`.
  const NODE_IMPORT = /(from\s*|\(\s*)["']onnxruntime-node["']/;
  const WEB_IMPORT = /(from\s*|\(\s*)["']onnxruntime-web["'/]/;
  it('uses a transformers node build that imports onnxruntime-node and not onnxruntime-web', () => {
    const tfDir = join(ROOT, 'node_modules', '@huggingface', 'transformers');
    // The export map holds the conditions at its top level, or under the "." key.
    const exportMap = JSON.parse(readFileSync(join(tfDir, 'package.json'), 'utf-8')).exports;
    const nodeExport = (exportMap['.'] ?? exportMap).node;
    for (const entry of [nodeExport.import.default, nodeExport.require.default]) {
      const code = readFileSync(join(tfDir, entry), 'utf-8');
      expect(code, `${entry} imports onnxruntime-node`).toMatch(NODE_IMPORT);
      expect(code, `${entry} imports onnxruntime-web`).not.toMatch(WEB_IMPORT);
    }
  });

  it('installs no registry copy of onnxruntime-web', () => {
    // bun installs no onnxruntime-web directory. npm links node_modules/onnxruntime-web to the stub.
    const installed = join(ROOT, 'node_modules', 'onnxruntime-web', 'package.json');
    const version = existsSync(installed) ? JSON.parse(readFileSync(installed, 'utf-8')).version : 'absent';
    expect(['absent', '0.0.0-stub']).toContain(version);
  });
});
