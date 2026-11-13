/**
 * Choose the Claude Code executable that the Agent SDK starts.
 *
 * The SDK starts a Claude Code binary from a platform package (`@anthropic-ai/claude-agent-sdk-<platform>-<arch>`)
 * by default. `EPISODIC_MEMORY_CLAUDE_BIN` names another binary. A host that sets the variable can remove the
 * platform package, which is 269 MB on Windows x64. The variable is an opt-in: when it is unset, the bundled
 * binary runs.
 *
 * The module imports only Node built-ins, because `cli/ensure-deps.js` imports it before `npm install`.
 * All output goes to stderr. Stdout of the MCP server belongs to JSON-RPC.
 */
import { spawnSync } from 'child_process';
/** The variable that names the Claude Code executable. Unset or blank selects the bundled binary. */
export declare const CLAUDE_BIN_ENV = "EPISODIC_MEMORY_CLAUDE_BIN";
/** The default bound of the `--version` probe. A `--version` call returns in well under one second. */
export declare const PROBE_TIMEOUT_MS = 10000;
/**
 * The Claude Code executable is unusable. The error is a deferral: the summary, digest and topic loops stop, and no
 * attempt is counted against a conversation. `detail` is the one line that the module writes to stderr.
 */
export declare class ClaudeBinError extends Error {
    /** The one-line reason. The sync banner shows the line. */
    readonly detail: string;
    constructor(detail: string);
}
/** The test seams and settings of the probe and the resolver. */
export interface ClaudeBinOptions {
    /** The variables to read. The default is `process.env`. */
    env?: Record<string, string | undefined>;
    /** The directory of the SDK package. The default resolves the SDK from this module. */
    sdkDir?: string;
    /** The platform and architecture of the bundled binary. The defaults are the process values. */
    platform?: string;
    arch?: string;
    /** The bound of the `--version` probe, in milliseconds. */
    timeoutMs?: number;
    /** Replaces `child_process.spawnSync`. */
    spawn?: typeof spawnSync;
    /** Text added to the line for a missing platform package, for example the Ollama backend. */
    hint?: string;
}
/**
 * Return the directory of the installed SDK package.
 *
 * @throws ClaudeBinError when the SDK package is not installed.
 */
export declare function resolveSdkDir(): string;
/**
 * Return the version floor of an executable: the `version` field of the SDK `manifest.json`.
 *
 * The manifest names the Claude Code release that the SDK bundles and tests. The manifest is in the SDK package,
 * not in the platform package, so the manifest stays when the platform package is removed.
 *
 * @throws ClaudeBinError when the manifest is missing or holds no three-part version.
 */
export declare function sdkFloor(sdkDir: string): string;
/**
 * Return true when a platform package with the bundled binary is installed.
 *
 * The lookup follows the SDK: the binary is `<package>/claude`, or `claude.exe` on win32, resolved from the SDK
 * package. On linux the SDK accepts the glibc and the musl package, so either one counts.
 */
export declare function bundledBinaryPresent(sdkDir: string, platform: string, arch: string): boolean;
/**
 * Run `<path> --version` once and check the version against the floor.
 *
 * A `.js` or `.mjs` path runs under the running node. Any other path runs directly. The child output is piped, so
 * nothing reaches the stdout of this process.
 *
 * @param path - An absolute path to a Claude Code binary, or to a `.js` or `.mjs` file.
 * @param floor - The lowest accepted version.
 * @param options - `timeoutMs` bounds the probe. `spawn` replaces `spawnSync`.
 * @returns The version that the executable printed.
 * @throws ClaudeBinError when the path is refused, the run fails or times out, or the version is below the floor.
 */
export declare function probeClaudeBin(path: string, floor: string, options?: Pick<ClaudeBinOptions, 'timeoutMs' | 'spawn'>): string;
/**
 * Return the executable option for an Agent SDK `query()` call.
 *
 * - The variable is unset or blank, and the platform package is present: `{}`. The bundled binary runs, and no
 *   probe runs.
 * - The variable is unset or blank, and the platform package is absent: a `ClaudeBinError`. The line names the
 *   variable. The run never falls back to a path that is not on disk.
 * - The variable is set: the path is probed once per process, and `{ pathToClaudeCodeExecutable }` is returned.
 *
 * @throws ClaudeBinError when no usable executable exists. The module writes each line to stderr once per process.
 */
export declare function claudeExecutableOption(options?: ClaudeBinOptions): {
    pathToClaudeCodeExecutable?: string;
};
