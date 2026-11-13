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
import { existsSync, readFileSync } from 'fs';
import { createRequire } from 'module';
import { dirname, extname, isAbsolute, join } from 'path';
/** The variable that names the Claude Code executable. Unset or blank selects the bundled binary. */
export const CLAUDE_BIN_ENV = 'EPISODIC_MEMORY_CLAUDE_BIN';
/** The default bound of the `--version` probe. A `--version` call returns in well under one second. */
export const PROBE_TIMEOUT_MS = 10_000;
const SDK_PACKAGE = '@anthropic-ai/claude-agent-sdk';
/** Extensions that run under node. The SDK also treats these as scripts. */
const SCRIPT_EXTENSIONS = new Set(['.js', '.mjs']);
/** Extensions that the probe refuses: shell shims, and scripts that need a loader. */
const REFUSED_EXTENSIONS = new Set(['.cmd', '.bat', '.ps1', '.ts', '.tsx', '.jsx', '.cjs']);
/**
 * The Claude Code executable is unusable. The error is a deferral: the summary, digest and topic loops stop, and no
 * attempt is counted against a conversation. `detail` is the one line that the module writes to stderr.
 */
export class ClaudeBinError extends Error {
    /** The one-line reason. The sync banner shows the line. */
    detail;
    constructor(detail) {
        super(detail);
        this.name = 'ClaudeBinError';
        this.detail = detail;
    }
}
const reported = new Set();
const probes = new Map();
/** Write the line once per process, then return the error to throw. */
function failure(detail) {
    if (!reported.has(detail)) {
        reported.add(detail);
        console.error(`episodic-memory: ${detail}`);
    }
    return new ClaudeBinError(detail);
}
/**
 * Return the directory of the installed SDK package.
 *
 * @throws ClaudeBinError when the SDK package is not installed.
 */
export function resolveSdkDir() {
    try {
        return dirname(createRequire(import.meta.url).resolve(SDK_PACKAGE));
    }
    catch {
        throw failure(`${SDK_PACKAGE} is not installed`);
    }
}
/**
 * Return the version floor of an executable: the `version` field of the SDK `manifest.json`.
 *
 * The manifest names the Claude Code release that the SDK bundles and tests. The manifest is in the SDK package,
 * not in the platform package, so the manifest stays when the platform package is removed.
 *
 * @throws ClaudeBinError when the manifest is missing or holds no three-part version.
 */
export function sdkFloor(sdkDir) {
    const path = join(sdkDir, 'manifest.json');
    let version;
    try {
        version = JSON.parse(readFileSync(path, 'utf-8')).version;
    }
    catch {
        throw failure(`cannot read the Claude Code version floor from ${path}`);
    }
    if (typeof version !== 'string' || !/^\d+\.\d+\.\d+/.test(version)) {
        throw failure(`${path} holds no Claude Code version`);
    }
    return /^\d+\.\d+\.\d+/.exec(version)[0];
}
/**
 * Return true when a platform package with the bundled binary is installed.
 *
 * The lookup follows the SDK: the binary is `<package>/claude`, or `claude.exe` on win32, resolved from the SDK
 * package. On linux the SDK accepts the glibc and the musl package, so either one counts.
 */
export function bundledBinaryPresent(sdkDir, platform, arch) {
    const base = `${SDK_PACKAGE}-${platform === 'android' ? 'linux' : platform}-${arch}`;
    const names = platform === 'linux' ? [base, `${base}-musl`] : platform === 'android' ? [`${base}-android`] : [base];
    const exe = platform === 'win32' ? 'claude.exe' : 'claude';
    const req = createRequire(join(sdkDir, 'package.json'));
    return names.some(name => {
        try {
            return existsSync(req.resolve(`${name}/${exe}`));
        }
        catch {
            return false;
        }
    });
}
function compareVersions(a, b) {
    const pa = a.split('.').map(Number);
    const pb = b.split('.').map(Number);
    for (let i = 0; i < 3; i++) {
        if (pa[i] !== pb[i])
            return pa[i] - pb[i];
    }
    return 0;
}
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
export function probeClaudeBin(path, floor, options = {}) {
    const { timeoutMs = PROBE_TIMEOUT_MS, spawn = spawnSync } = options;
    const name = `${CLAUDE_BIN_ENV}=${path}`;
    if (!isAbsolute(path))
        throw failure(`${name} is not an absolute path; the variable has no PATH lookup`);
    const ext = extname(path).toLowerCase();
    if (REFUSED_EXTENSIONS.has(ext)) {
        throw failure(`${name} names a ${ext} file; name the Claude Code binary or a .js or .mjs file`);
    }
    if (!existsSync(path))
        throw failure(`${name} does not exist`);
    const script = SCRIPT_EXTENSIONS.has(ext);
    const r = spawn(script ? process.execPath : path, script ? [path, '--version'] : ['--version'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: timeoutMs,
        encoding: 'utf-8',
        windowsHide: true,
    });
    if (r.error) {
        const timedOut = r.error.code === 'ETIMEDOUT';
        throw failure(`${name} --version ${timedOut ? `timed out after ${timeoutMs} ms` : `failed: ${r.error.message}`}`);
    }
    if (r.status !== 0)
        throw failure(`${name} --version ended with exit code ${r.status}`);
    const found = /^(\d+\.\d+\.\d+)/.exec(String(r.stdout ?? '').trim());
    if (!found)
        throw failure(`${name} --version printed no version`);
    if (compareVersions(found[1], floor) < 0) {
        throw failure(`${name} is version ${found[1]}, below the SDK floor ${floor}`);
    }
    return found[1];
}
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
export function claudeExecutableOption(options = {}) {
    const env = options.env ?? process.env;
    const path = (env[CLAUDE_BIN_ENV] ?? '').trim();
    const sdkDir = options.sdkDir ?? resolveSdkDir();
    if (!path) {
        const platform = options.platform ?? process.platform;
        const arch = options.arch ?? process.arch;
        if (bundledBinaryPresent(sdkDir, platform, arch))
            return {};
        const hint = options.hint ? `, ${options.hint}` : '';
        throw failure(`the bundled Claude Code binary (${SDK_PACKAGE}-${platform}-${arch}) is not installed under ${dirname(sdkDir)}; ` +
            `set ${CLAUDE_BIN_ENV} to a Claude Code binary${hint}`);
    }
    const key = `${path}\0${sdkDir}`;
    const cached = probes.get(key);
    if (cached?.error)
        throw cached.error;
    if (cached?.version)
        return { pathToClaudeCodeExecutable: path };
    try {
        const version = probeClaudeBin(path, sdkFloor(sdkDir), options);
        probes.set(key, { version });
        return { pathToClaudeCodeExecutable: path };
    }
    catch (error) {
        if (error instanceof ClaudeBinError)
            probes.set(key, { error });
        throw error;
    }
}
