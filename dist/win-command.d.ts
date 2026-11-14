/** The file, the arguments and the spawn option that run one command. */
export interface CommandInvocation {
    file: string;
    args: string[];
    /** True when `file` is cmd.exe: the spawn must pass the command line unchanged. */
    windowsVerbatimArguments: boolean;
}
/**
 * Finds the file that Windows runs for `command`, or undefined.
 *
 * A name with a directory part is checked as given. A bare name is searched in each PATH directory with each
 * PATHEXT extension, in order. A name that has an extension is also tried as given.
 */
export declare function findWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined;
/**
 * Returns how to spawn `command` with `args` on this platform.
 *
 * Outside Windows the command is unchanged. On Windows, `spawn('codex')` without a shell does not use PATHEXT,
 * so it does not find an npm shim such as `codex.cmd`, and Node refuses to spawn a `.cmd` or `.bat` file
 * directly. The function therefore resolves the file and runs a batch file through cmd.exe. A command that
 * cannot be found is returned unchanged, so the spawn fails with ENOENT as before.
 *
 * @throws Error when a batch file would get an argument that holds a space or a cmd.exe syntax character.
 */
export declare function commandInvocation(command: string, args: readonly string[], env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform): CommandInvocation;
