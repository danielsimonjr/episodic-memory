/**
 * The minimum Codex CLI version that summarization requires.
 *
 * The summarizer and the doctor both compare the Codex CLI version with this minimum.
 */
export declare const MIN_CODEX_VERSION = "0.130.0";
/**
 * Finds the first `major.minor.patch` number in the text of a Codex CLI version report.
 *
 * Returns undefined when the text holds no such number.
 */
export declare function parseCodexCliVersion(output: string): string | undefined;
/**
 * Compares two dotted version strings part by part, as numbers.
 *
 * Only the first three parts count. A missing or non-numeric part counts as 0.
 * The function ignores a suffix such as `-beta`. Only the leading digits of a part count.
 * The result is negative when `a` is lower, zero when the parts match, and positive when `a` is higher.
 */
export declare function compareSemver(a: string, b: string): number;
/**
 * Reports whether a Codex CLI version is at or above the minimum.
 *
 * A value with no numeric parts compares as 0.0.0.
 *
 * @param version A dotted version string, such as the result of parseCodexCliVersion.
 * @param minimum The lowest accepted version. Defaults to MIN_CODEX_VERSION.
 */
export declare function versionMeetsMinimum(version: string, minimum?: string): boolean;
/**
 * Builds the error message for a Codex CLI that the summarizer rejects.
 *
 * The message does not compare versions. The caller decides whether the CLI is too old.
 * The message names MIN_CODEX_VERSION. When no version parses, the message quotes the trimmed output.
 * Otherwise, the message names the parsed version.
 *
 * @param versionOutput The output of the Codex CLI version command.
 */
export declare function codexVersionRequirementMessage(versionOutput: string): string;
