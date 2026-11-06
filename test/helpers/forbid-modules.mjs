/**
 * A loader probe for child-process tests: make a module graph fail to load.
 *
 * The digest hook and the MCP server must not reach heavy modules on their fast
 * paths (memoryjs, the Agent SDK, transformers, sqlite-vec). Asserting that by
 * grepping the source is not enough — a transitive import three modules away
 * would still load them. This probe is installed into the child with
 * `NODE_OPTIONS=--import=file://<this file>` and makes the named specifiers
 * throw at resolve time, so a test can prove the process never asked for them.
 *
 * The list comes from `FORBID_MODULES` (comma-separated package names). A
 * subpath of a named package (`pkg/dist/x.js`) is rejected too.
 */

import { register } from 'node:module';

const raw = process.env.FORBID_MODULES ?? '';
const forbidden = raw
  .split(',')
  .map((entry) => entry.trim())
  .filter(Boolean);

/** Runs in the loader thread; must be self-contained (no closure over this module). */
const HOOK_SOURCE = `
const forbidden = ${JSON.stringify(forbidden)};

export async function resolve(specifier, context, nextResolve) {
  for (const name of forbidden) {
    if (specifier === name || specifier.startsWith(name + '/')) {
      throw new Error('forbidden module loaded: ' + specifier);
    }
  }
  return nextResolve(specifier, context);
}
`;

if (forbidden.length > 0) {
  register('data:text/javascript,' + encodeURIComponent(HOOK_SOURCE));
}
