import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

// better-sqlite3 is a NATIVE module: without its postinstall, better_sqlite3.node is never built
// and every sync dies with "Could not locate the bindings file". npm 11 skips install scripts
// unless package.json declares allowScripts, and `claude plugin update` clones this repo into a
// fresh version directory and runs npm install there - so the declaration MUST live in the repo,
// not on any one machine.
//
// THIS BIT THREE TIMES: 1.5.2, 1.5.3 and 1.5.4 all shipped with the addon unbuilt, and I fixed it
// by hand twice before fixing the cause. Each time the scheduled sync failed with rc=1 and a
// scheduled task has nowhere to print.
//
// THE PIN IS THE REASON THIS TEST EXISTS. npm writes the key VERSION-PINNED
// ("better-sqlite3@12.11.1"). Bump the dependency and the key silently stops matching - the
// approval quietly lapses and the exact same silent failure returns. This test fails LOUDLY at
// that moment instead.
describe('allowScripts declaration for native modules', () => {
  it('declares allowScripts for better-sqlite3', () => {
    expect(pkg.allowScripts, 'package.json must declare allowScripts').toBeDefined();
    const keys = Object.keys(pkg.allowScripts);
    expect(keys.some((k) => k.startsWith('better-sqlite3@'))).toBe(true);
  });

  // Compare the pin against the LOCKFILE, not against package.json's dependency RANGE.
  // dependencies says "^12.4.1" while npm pins the RESOLVED version "12.11.1" - they legitimately
  // differ, and my first version of this test compared them directly and failed on a healthy
  // repo. The lockfile is what a fresh `npm install` in the plugin cache will actually produce,
  // so it is the only comparison that predicts the deployed outcome.
  it('the allowScripts PIN matches the version the lockfile will install', () => {
    const lock = JSON.parse(readFileSync(join(process.cwd(), 'package-lock.json'), 'utf-8'));
    const resolved = lock.packages?.['node_modules/better-sqlite3']?.version;
    expect(resolved, 'package-lock.json must resolve better-sqlite3').toBeTruthy();
    const key = Object.keys(pkg.allowScripts).find((k) => k.startsWith('better-sqlite3@'));
    const pinned = key!.split('@').pop();
    // If this fails the approval has LAPSED and the native addon will silently not build.
    // Fix by re-running:  npm approve-scripts better-sqlite3
    expect(pinned, `allowScripts pins ${pinned} but the lockfile installs ${resolved} - the approval has lapsed and better_sqlite3.node will NOT be built`).toBe(resolved);
  });

  it('is enabled, not merely present', () => {
    const key = Object.keys(pkg.allowScripts).find((k) => k.startsWith('better-sqlite3@'));
    expect(pkg.allowScripts[key!]).toBe(true);
  });
});
