/**
 * Prints one usage error line for a CLI command and exits with code 2.
 *
 * Each command entry point calls this function for an unknown option or a bad option value, before any work.
 * The line names the command, the reason and the help command, so a caller sees one stderr line.
 *
 * @param command The subcommand name, for example `search`.
 * @param reason The cause, for example `unknown option --zzz`.
 */
export declare function refuseUsage(command: string, reason: string): never;
/**
 * Reads a positive integer option value, or refuses the command.
 *
 * `parseInt` accepts `5abc` and gives NaN for `abc`, so the function checks the whole value.
 *
 * @param command The subcommand name, for the usage line.
 * @param option The option name, for example `--limit`.
 * @param value The text after the option, or `undefined` when the option is the last argument.
 */
export declare function positiveIntegerOption(command: string, option: string, value: string | undefined): number;
