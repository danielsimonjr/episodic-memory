import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

const pkg = JSON.parse(readFileSync(join(process.cwd(), 'package.json'), 'utf-8'));

/**
 * Resolve the better-sqlite3 version the committed Bun lockfile will install.
 * bun.lock is not JSON; the packages map uses `"name": ["name@version", ...]`.
 */
function resolvedBetterSqlite3FromBunLock(lockText: string): string | undefined {
  const match = lockText.match(/^\s+"better-sqlite3":\s+\["better-sqlite3@([^"]+)"/m);
  return match?.[1];
}

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
  // Dev/CI install via Bun (bun.lock). Plugin first-run install still uses npm (wrapper), so the
  // better-sqlite3 dependency is also pinned exact so npm without a lockfile resolves the same
  // version the allowScripts key approves.
  it('the allowScripts PIN matches the version the lockfile will install', () => {
    const lockPath = join(process.cwd(), 'bun.lock');
    expect(existsSync(lockPath), 'bun.lock must be committed (single lockfile)').toBe(true);
    expect(
      existsSync(join(process.cwd(), 'package-lock.json')),
      'package-lock.json must not be committed alongside bun.lock'
    ).toBe(false);

    const lockText = readFileSync(lockPath, 'utf-8');
    const resolved = resolvedBetterSqlite3FromBunLock(lockText);
    expect(resolved, 'bun.lock must resolve better-sqlite3').toBeTruthy();
    const key = Object.keys(pkg.allowScripts).find((k) => k.startsWith('better-sqlite3@'));
    const pinned = key!.split('@').pop();
    // If this fails the approval has LAPSED and the native addon will silently not build.
    // Fix by re-running:  npm approve-scripts better-sqlite3
    expect(
      pinned,
      `allowScripts pins ${pinned} but the lockfile installs ${resolved} - the approval has lapsed and better_sqlite3.node will NOT be built`
    ).toBe(resolved);
  });

  it('pins better-sqlite3 exact so npm plugin installs match allowScripts', () => {
    const dep = pkg.dependencies?.['better-sqlite3'];
    expect(dep, 'better-sqlite3 must be a direct dependency').toBeTruthy();
    // Exact pin (no ^/~) so a lockfile-less `npm install` in the plugin cache cannot drift
    // past the allowScripts version key.
    expect(dep, 'better-sqlite3 must be an exact version (no range) for npm plugin installs').toMatch(
      /^\d+\.\d+\.\d+$/
    );
    const key = Object.keys(pkg.allowScripts).find((k) => k.startsWith('better-sqlite3@'));
    const pinned = key!.split('@').pop();
    expect(dep).toBe(pinned);
  });

  it('is enabled, not merely present', () => {
    const key = Object.keys(pkg.allowScripts).find((k) => k.startsWith('better-sqlite3@'));
    expect(pkg.allowScripts[key!]).toBe(true);
  });
});
