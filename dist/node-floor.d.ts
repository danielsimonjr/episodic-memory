/**
 * Node version floor, enforced at launch — dependency-free so both entry points can import it
 * before anything heavy.
 *
 * memoryjs (the knowledge store behind `learn`) declares `node >= 22.12.0`. `engines` is advisory:
 * npm warns and installs anyway, so a host on Node 20 starts the wrapper, completes a 200-package
 * install, and then fails inside memoryjs with an error that names neither the package nor the
 * version. The entry points check the floor themselves and print one line instead.
 *
 * The version is an ARGUMENT rather than a read of `process.versions.node` so it can be tested
 * with an explicit string. Do not fake `process.versions.node` in a wrapper's process: that
 * proves nothing about the child process the wrapper will spawn.
 */
/** The Node floor memoryjs requires. Kept in sync with `engines.node` in package.json. */
export declare const NODE_FLOOR = "22.12.0";
/**
 * Returns the stderr line to print when `version` is below the floor, or null when it passes.
 * An unparseable version fails closed: an unknown runtime is not a supported runtime.
 */
export declare function assertNodeFloor(version?: string): string | null;
