import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';
import { builtinModules } from 'module';
import ts from 'typescript';
import { NPM_INSTALL_ARGS } from '../cli/ensure-deps.js';

const ROOT = path.resolve(__dirname, '..');

/** Every file that a plugin host runs: the built code, the CLI and hook entry points, and the postinstall script. */
function runtimeFiles(): string[] {
  const files: string[] = [];
  const walk = (dir: string) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (p.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(ROOT, 'dist'));
  for (const f of fs.readdirSync(path.join(ROOT, 'cli'))) {
    if (f.endsWith('.js')) files.push(path.join(ROOT, 'cli', f));
  }
  files.push(path.join(ROOT, 'scripts', 'rebuild-native.mjs'));
  return files;
}

/** The package name of a bare specifier: `@scope/name/sub` gives `@scope/name`, `name/sub` gives `name`. */
function packageName(specifier: string): string {
  const parts = specifier.split('/');
  return specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0];
}

describe('plugin-host install', () => {
  it('omits the devDependencies and keeps the optional platform packages', () => {
    expect(NPM_INSTALL_ARGS[0]).toBe('install');
    expect(NPM_INSTALL_ARGS).toContain('--omit=dev');
    expect(NPM_INSTALL_ARGS.some((a: string) => a.startsWith('--omit=') && a !== '--omit=dev')).toBe(false);
  });

  it('runtime files import only Node built-ins and declared dependencies', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const allowed = new Set([
      ...Object.keys(pkg.dependencies ?? {}),
      ...Object.keys(pkg.optionalDependencies ?? {}),
    ]);
    const builtins = new Set(builtinModules);
    const files = runtimeFiles();
    expect(files.length).toBeGreaterThan(50);

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
    // A scan that finds no bare import read nothing, and its empty list proves nothing.
    expect(bare).toBeGreaterThan(20);
    expect(bad).toEqual([]);
  });

  it('flags a devDependency import, so the scan can fail', () => {
    const { importedFiles } = ts.preProcessFile("import { x } from 'vitest';\n// from 'typescript'\n", true, true);
    expect(importedFiles.map(f => f.fileName)).toEqual(['vitest']);
  });
});
