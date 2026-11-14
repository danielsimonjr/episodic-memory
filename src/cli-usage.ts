/**
 * Prints one usage error line for a CLI command and exits with code 2.
 *
 * Each command entry point calls this function for an unknown option or a bad option value, before any work.
 * The line names the command, the reason and the help command, so a caller sees one stderr line.
 *
 * @param command The subcommand name, for example `search`.
 * @param reason The cause, for example `unknown option --zzz`.
 */
export function refuseUsage(command: string, reason: string): never {
  console.error(`episodic-memory ${command}: ${reason}. Run 'episodic-memory ${command} --help'.`);
  process.exit(2);
}

/**
 * Reads a positive integer option value, or refuses the command.
 *
 * `parseInt` accepts `5abc` and gives NaN for `abc`, so the function checks the whole value.
 *
 * @param command The subcommand name, for the usage line.
 * @param option The option name, for example `--limit`.
 * @param value The text after the option, or `undefined` when the option is the last argument.
 */
export function positiveIntegerOption(command: string, option: string, value: string | undefined): number {
  if (value === undefined) refuseUsage(command, `option ${option} needs a value`);
  if (!/^[1-9]\d*$/.test(value)) refuseUsage(command, `option ${option} needs a positive integer, not ${value}`);
  return Number(value);
}
