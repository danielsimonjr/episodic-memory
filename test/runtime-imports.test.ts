import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { builtinModules } from 'module';
import ts from 'typescript';
import { NPM_INSTALL_ARGS } from '../cli/ensure-deps.js';

const ROOT = path.resolve(__dirname, '..');
const SCRIPT = /\.(js|mjs|cjs)$/;

/** Every file that a plugin host runs: the built code, and the CLI and hook entry points. */
function runtimeFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (SCRIPT.test(p)) files.push(p);
    }
  };
  walk(path.join(ROOT, 'dist'));
  for (const f of fs.readdirSync(path.join(ROOT, 'cli'))) {
    if (SCRIPT.test(f)) files.push(path.join(ROOT, 'cli', f));
  }
  return files;
}

/** The package name of a bare specifier: `@scope/name/sub` gives `@scope/name`, `name/sub` gives `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

/** The packages that a plugin host installs: `dependencies` and `optionalDependencies` of package.json. */
function runtimePackages(): Set<string> {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  return new Set([...Object.keys(pkg.dependencies ?? {}), ...Object.keys(pkg.optionalDependencies ?? {})]);
}

/**
 * Scan files for bare imports that a plugin host cannot resolve.
 *
 * @returns `bad` lists each `file: specifier` that is not a Node built-in or an allowed package; `bare` counts every bare import read
 */
function scanImports(files: string[], allowed: Set<string>): { bad: string[]; bare: number } {
  const builtins = new Set(builtinModules);
  const bad: string[] = [];
  let bare = 0;
  for (const file of files) {
    const { importedFiles } = ts.preProcessFile(fs.readFileSync(file, 'utf8'), true, true);
    for (const { fileName } of importedFiles) {
      if (fileName.startsWith('.') || fileName.startsWith('/')) continue;
      bare++;
      if (fileName.startsWith('node:') || builtins.has(fileName)) continue;
      if (!allowed.has(packageName(fileName))) bad.push(`${path.relative(ROOT, file)}: ${fileName}`);
    }
  }
  return { bad, bare };
}

describe('plugin-host install', () => {
  it('omits the devDependencies and keeps the optional platform packages', () => {
    expect(NPM_INSTALL_ARGS[0]).toBe('install');
    expect(NPM_INSTALL_ARGS).toContain('--omit=dev');
    expect(NPM_INSTALL_ARGS.some((a: string) => a.startsWith('--omit=') && a !== '--omit=dev')).toBe(false);
  });

  it('runtime files import only Node built-ins and declared dependencies', () => {
    const files = runtimeFiles();
    expect(files.length).toBeGreaterThan(50);
    const { bad, bare } = scanImports(files, runtimePackages());
    // A scan that finds no bare import read nothing, and its empty list proves nothing.
    expect(bare).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it('flags a devDependency import, so the scan can fail', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'em-runtime-imports-'));
    try {
      const file = path.join(dir, 'planted.js');
      fs.writeFileSync(file, "import fs from 'fs';\nimport { x } from 'vitest';\n// from 'typescript'\nimport z from 'zod/v4';\n");
      const { bad, bare } = scanImports([file], runtimePackages());
      expect(bare).toBe(3);
      expect(bad).toEqual([`${path.relative(ROOT, file)}: vitest`]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
