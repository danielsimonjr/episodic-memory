/**
 * Help text for `episodic-memory learn`.
 *
 * This module has no imports on purpose. `learn --help` prints it before any
 * heavy module loads, so it must not sit on the `cli-main` graph (tasks →
 * summarizer → Agent SDK, knowledge store → memoryjs).
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

  learn approve | export | render
      Not implemented yet.

Progress goes to stderr; the report goes to stdout.`;
