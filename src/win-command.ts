import fs from 'fs';
import path from 'path';

/** The file, the arguments and the spawn option that run one command. */
export interface CommandInvocation {
  file: string;
  args: string[];
  /** True when `file` is cmd.exe: the spawn must pass the command line unchanged. */
  windowsVerbatimArguments: boolean;
}

/** The PATHEXT value that Windows uses when the variable is unset. */
const DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/** Characters that cmd.exe reads as syntax. An argument with one of them is refused, not quoted. */
const CMD_SYNTAX = /[\s"&|<>^%!()]/;

/** Reads a variable of `env` without regard to case, as Windows does (`Path` and `PATH` are one variable). */
function envValue(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const key = Object.keys(env).find(k => k.toUpperCase() === name);
  return key === undefined ? undefined : env[key];
}

/**
 * Finds the file that Windows runs for `command`, or undefined.
 *
 * A name with a directory part is checked as given. A bare name is searched in each PATH directory with each
 * PATHEXT extension, in order. A name that has an extension is also tried as given.
 */
export function findWindowsCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  const exts = (envValue(env, 'PATHEXT') || DEFAULT_PATHEXT).split(';').filter(Boolean);
  const names = path.extname(command) ? [command, ...exts.map(e => command + e)] : exts.map(e => command + e);
  const isFile = (p: string) => {
    try {
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (command.includes('/') || command.includes('\\')) return names.find(isFile);
  for (const dir of (envValue(env, 'PATH') || '').split(path.delimiter).filter(Boolean)) {
    const hit = names.map(n => path.join(dir, n)).find(isFile);
    if (hit) return hit;
  }
  return undefined;
}

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
export function commandInvocation(
  command: string,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): CommandInvocation {
  const plain = { file: command, args: [...args], windowsVerbatimArguments: false };
  if (platform !== 'win32') return plain;
  const found = findWindowsCommand(command, env);
  if (!found) return plain;
  const ext = path.extname(found).toLowerCase();
  if (ext !== '.cmd' && ext !== '.bat') return { ...plain, file: found };
  const bad = args.find(a => a === '' || CMD_SYNTAX.test(a));
  if (bad !== undefined) throw new Error(`refusing to pass the argument ${JSON.stringify(bad)} to the batch file ${found}`);
  const comspec = envValue(env, 'COMSPEC') || 'cmd.exe';
  return { file: comspec, args: ['/d', '/s', '/c', `""${found}" ${args.join(' ')}"`], windowsVerbatimArguments: true };
}
