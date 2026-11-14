/**
 * Help text for `episodic-memory learn`.
 *
 * This module has no imports on purpose. `learn --help` prints it before any
 * heavy module loads, so it must not sit on the `cli-main` graph (tasks →
 * summarizer → Agent SDK, knowledge store → node:sqlite).
 */

export const LEARN_USAGE = `Usage: episodic-memory learn <command> [options]

Self-improving memory over the conversation archive. Every command needs
EPISODIC_MEMORY_LEARN=1; without it each exits 0 and does nothing.

COMMANDS:
  learn tasks [--per-project N] [--seed S] [--check]
      Generate self-practice tasks from the archive. --check marks the tasks
      whose source address no longer resolves as stale.

  learn solve [--split train|test] [--limit N] [--snapshot ID]
      Solve stored tasks and record graded attempts. Default split: train.

  learn status
      The flag, entries by kind and status, candidates awaiting approval, and
      the latest run.

  learn report [--run ID] [--json]
      Pass rates before and after, kept and pending entries, rejections with
      reasons, budget, child runs and reflections. Default: the latest run.

  learn bootstrap [--per-project N] [--seed S]
      Map each eligible project's archive, propose a navigation skill and
      exploration notes, merge them into one global instruction, then measure
      them against the signal train tasks before keeping anything.

  learn improve [--rounds N] [--project P] [--dry-run]
      The recursive learner: solve the signal train tasks, split the failures
      into leaves, let each leaf learn and validate, merge duplicates across
      leaves, reflect, then evaluate the held-out split once at the end.
      --dry-run solves and reports without running any learner.

  learn approve <name> [--yes]
      Activate a candidate as ground truth after showing the entry, its
      validation record and a diff against the version it revises. <name> is
      learned:<kind>:<project>:<slug>:v<n> or kind/project/slug. Refuses an
      entry with no measurement or with a recorded regression. Prompts for y on
      a TTY; --yes approves without asking.

  learn export [--to DIR]
      Write every active skill as <project>/<slug>/SKILL.md under
      learned-skills/, replacing that tree. --to DIR copies into DIR instead
      and removes nothing there.

  learn render [--project P]
      Rewrite the learned-hints block the SessionStart hook injects, from the
      entries that are active now, and list each block's size. --project P
      prints that project's block after rendering. The block is rewritten after
      every run and approval anyway; use this after editing the store by hand
      or to inspect what a session will see.

Progress goes to stderr; the report goes to stdout.`;

/**
 * The options that each subcommand reads. A name here must match the `optionValue`, `optionNumber` or
 * `hasFlag` call of that command in `cli-main.ts`. The keys must match `IMPLEMENTED` there.
 */
export const LEARN_OPTIONS_BY_COMMAND: Readonly<Record<string, readonly string[]>> = {
  tasks: ['seed', 'per-project', 'check'],
  solve: ['split', 'snapshot', 'limit'],
  bootstrap: ['seed', 'per-project'],
  improve: ['project', 'rounds', 'dry-run'],
  status: [],
  approve: ['yes'],
  export: ['to'],
  render: ['project'],
  report: ['run', 'json'],
};

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
export function learnOptionRefusal(command: string, argv: readonly string[]): string | undefined {
  const known = LEARN_OPTIONS_BY_COMMAND[command];
  if (known === undefined) return undefined;
  for (const arg of argv) {
    if (!arg.startsWith('-')) continue;
    const name = arg.replace(/^--?/, '').split('=')[0];
    if (!arg.startsWith('--') || !known.includes(name)) {
      return `episodic-memory learn: unknown option ${arg} for learn ${command}. Run 'episodic-memory learn --help'.`;
    }
  }
  return undefined;
}
