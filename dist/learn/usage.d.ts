/**
 * Help text for `episodic-memory learn`.
 *
 * This module has no imports on purpose. `learn --help` prints it before any
 * heavy module loads, so it must not sit on the `cli-main` graph (tasks →
 * summarizer → Agent SDK, knowledge store → node:sqlite).
 */
export declare const LEARN_USAGE = "Usage: episodic-memory learn <command> [options]\n\nSelf-improving memory over the conversation archive. Every command needs\nEPISODIC_MEMORY_LEARN=1; without it each exits 0 and does nothing.\n\nCOMMANDS:\n  learn tasks [--per-project N] [--seed S] [--check]\n      Generate self-practice tasks from the archive. --check marks the tasks\n      whose source address no longer resolves as stale.\n\n  learn solve [--split train|test] [--limit N] [--snapshot ID]\n      Solve stored tasks and record graded attempts. Default split: train.\n\n  learn status\n      The flag, entries by kind and status, candidates awaiting approval, and\n      the latest run.\n\n  learn report [--run ID] [--json]\n      Pass rates before and after, kept and pending entries, rejections with\n      reasons, budget, child runs and reflections. Default: the latest run.\n\n  learn bootstrap [--per-project N] [--seed S]\n      Map each eligible project's archive, propose a navigation skill and\n      exploration notes, merge them into one global instruction, then measure\n      them against the signal train tasks before keeping anything.\n\n  learn improve [--rounds N] [--project P] [--dry-run]\n      The recursive learner: solve the signal train tasks, split the failures\n      into leaves, let each leaf learn and validate, merge duplicates across\n      leaves, reflect, then evaluate the held-out split once at the end.\n      --dry-run solves and reports without running any learner.\n\n  learn approve <name> [--yes]\n      Activate a candidate as ground truth after showing the entry, its\n      validation record and a diff against the version it revises. <name> is\n      learned:<kind>:<project>:<slug>:v<n> or kind/project/slug. Refuses an\n      entry with no measurement or with a recorded regression. Prompts for y on\n      a TTY; --yes approves without asking.\n\n  learn export [--to DIR]\n      Write every active skill as <project>/<slug>/SKILL.md under\n      learned-skills/, replacing that tree. --to DIR copies into DIR instead\n      and removes nothing there.\n\n  learn render [--project P]\n      Rewrite the learned-hints block the SessionStart hook injects, from the\n      entries that are active now, and list each block's size. --project P\n      prints that project's block after rendering. The block is rewritten after\n      every run and approval anyway; use this after editing the store by hand\n      or to inspect what a session will see.\n\nProgress goes to stderr; the report goes to stdout.";
/**
 * The options that each subcommand reads. A name here must match the `optionValue`, `optionNumber` or
 * `hasFlag` call of that command in `cli-main.ts`. The keys must match `IMPLEMENTED` there.
 */
export declare const LEARN_OPTIONS_BY_COMMAND: Readonly<Record<string, readonly string[]>>;
/**
 * Returns the usage error line for the first option that `command` does not read, or undefined.
 *
 * Without the check, a misspelled option runs the command with the default value and says nothing.
 * The check skips an argument that does not start with `-`: `approve` reads its name from one, and an
 * option value is one. An unknown command returns undefined, because the caller refuses it first.
 *
 * @param command The learn subcommand, for example `tasks`.
 * @param argv The arguments after the subcommand.
 */
export declare function learnOptionRefusal(command: string, argv: readonly string[]): string | undefined;
