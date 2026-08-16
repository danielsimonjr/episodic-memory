#!/usr/bin/env node
/**
 * rebuild-native.js - build the native addons this package needs, on the host that will run them.
 *
 * WHY THIS FILE EXISTS
 *   postinstall used to be:
 *
 *       npm rebuild better-sqlite3 2>/dev/null || true
 *
 *   which is POSIX shell. npm runs scripts through cmd.exe on Windows, where `/dev/null` is not a
 *   path and `true` is not a command. Tested directly on Windows 11, that line produces:
 *
 *       The system cannot find the path specified.
 *       'true' is not recognized as an internal or external command
 *       exit code 1
 *
 *   cmd fails on the redirect BEFORE npm ever runs, so the rebuild never happened at all - and the
 *   `|| true` that was meant to make it non-fatal is itself the thing that errors.
 *
 *   The consequence was real. episodic-memory 1.5.0 installed into the plugin cache with no
 *   better_sqlite3.node, so the CLI died on any command that opens the index:
 *
 *       Error: Could not locate the bindings file
 *
 *   The MCP path survived because cli/mcp-server-wrapper.js runs its own `npm install`. Two entry
 *   points into one package, only one of which performed setup - so everything arriving through the
 *   wrapper worked and proved nothing about anything that did not.
 *
 * TWO RULES THIS FILE FOLLOWS
 *   1. NON-FATAL, BUT NEVER SILENT. A failed native build must not break `npm install` - a
 *      developer on a machine with no toolchain should still get a working checkout. But the old
 *      form swallowed the reason as well as the failure, and a silent skip is why this went
 *      unnoticed. Failures print, loudly, and say what to run next.
 *   2. VERIFY THE ARTIFACT, NOT THE EXIT CODE. `npm rebuild` can report success without producing
 *      a loadable binding. This checks that better_sqlite3.node actually exists afterwards and says
 *      so either way, because "the command succeeded" and "the thing exists" are different claims.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/** Native modules that must be compiled against the host's Node ABI. */
const NATIVE = ['better-sqlite3'];

/** npm is a shell script on POSIX and a .cmd shim on Windows; spawn needs the right one. */
const NPM = process.platform === 'win32' ? 'npm.cmd' : 'npm';

/** Recursively look for a built .node addon under a package directory. */
function findAddon(pkgDir, addonName) {
  if (!existsSync(pkgDir)) return null;
  const stack = [pkgDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        // node_modules nesting can be deep and irrelevant; the addon lives under build/ or similar.
        if (e.name !== 'node_modules') stack.push(full);
      } else if (e.name === addonName) {
        return full;
      }
    }
  }
  return null;
}

let failed = 0;

for (const pkg of NATIVE) {
  const addon = `${pkg.replace(/-/g, '_')}.node`;
  const pkgDir = join(repoRoot, 'node_modules', pkg);

  if (findAddon(pkgDir, addon)) {
    console.log(`[rebuild-native] ${pkg}: already built, skipping`);
    continue;
  }

  console.log(`[rebuild-native] ${pkg}: building native addon for node ${process.version} on ${process.platform}...`);

  // shell:true is REQUIRED on Windows, not a convenience. npm is a .cmd shim there, and since the
  // CVE-2024-27980 mitigation Node refuses to spawn .cmd/.bat without a shell - spawnSync returns
  // status null having never launched anything. Caught by the positive control for this script: with
  // shell:false it reported "NOT BUILT (npm rebuild exit n/a)" and the binding never reappeared.
  // The arguments here are fixed literals, so there is no interpolation for a shell to mis-parse.
  const res = spawnSync(NPM, ['rebuild', pkg], { cwd: repoRoot, stdio: 'inherit', shell: true });
  if (res.error) console.warn(`[rebuild-native] ${pkg}: spawn failed - ${res.error.message}`);

  // Exit code is only half the answer - check the artifact.
  const built = findAddon(pkgDir, addon);
  if (built) {
    const kb = Math.round(statSync(built).size / 1024);
    console.log(`[rebuild-native] ${pkg}: OK - ${addon} (${kb} KB)`);
  } else {
    failed++;
    console.warn(
      `[rebuild-native] ${pkg}: NOT BUILT (npm rebuild exit ${res.status ?? 'n/a'}).\n` +
      `[rebuild-native]   Commands that open the index will fail with "Could not locate the bindings file".\n` +
      `[rebuild-native]   Fix on this host with:  npm rebuild ${pkg}\n` +
      `[rebuild-native]   That usually needs a C++ toolchain (Windows: Visual Studio Build Tools).`
    );
  }
}

// Always exit 0. A missing toolchain must not break `npm install`; the warning above is the signal,
// and it is deliberately impossible to miss in a way the old `2>/dev/null || true` never was.
process.exit(0);
