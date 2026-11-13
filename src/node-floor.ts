/**
 * Node version floor, enforced at launch — dependency-free so both entry points can import it
 * before anything heavy.
 *
 * The database layer runs on node:sqlite. Its `DatabaseSync.isTransaction` first shipped in Node 22.16.0.
 * `engines` is advisory: npm warns and installs anyway, so a host on an older Node starts the wrapper,
 * completes a 200-package install, and then fails inside a dependency with an error that names
 * neither the package nor the version. The entry points check the floor themselves and print one
 * line instead.
 *
 * The version is an ARGUMENT rather than a read of `process.versions.node` so it can be tested
 * with an explicit string. Do not fake `process.versions.node` in a wrapper's process: that
 * proves nothing about the child process the wrapper will spawn.
 */

/** The Node floor of node:sqlite (DatabaseSync.isTransaction, Node 22.16.0). Kept in sync with `engines.node` in package.json. */
export const NODE_FLOOR = '22.16.0';

function parseVersion(version: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(version.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function compare(a: [number, number, number], b: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Returns the stderr line to print when `version` is below the floor, or null when it passes.
 * An unparseable version fails closed: an unknown runtime is not a supported runtime.
 */
export function assertNodeFloor(version: string = process.versions.node): string | null {
  const actual = parseVersion(version);
  if (actual === null) {
    return `episodic-memory: cannot read the Node version "${version}"; ${NODE_FLOOR} or newer is required.`;
  }
  if (compare(actual, parseVersion(NODE_FLOOR)!) >= 0) return null;
  return `episodic-memory: Node ${NODE_FLOOR} or newer is required (this is ${version}). Upgrade Node and retry.`;
}
