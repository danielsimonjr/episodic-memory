/**
 * Help text for `episodic-memory learn`.
 *
 * This module has no imports on purpose. `learn --help` prints it before any
 * heavy module loads, so it must not sit on the `cli-main` graph (tasks →
 * summarizer → Agent SDK, knowledge store → memoryjs).
 */
export declare const LEARN_USAGE = "Usage: episodic-memory learn <command> [options]\n\nSelf-improving memory over the conversation archive. Every command needs\nEPISODIC_MEMORY_LEARN=1; without it each exits 0 and does nothing.\n\nCOMMANDS:\n  learn tasks [--per-project N] [--seed S] [--check]\n      Generate self-practice tasks from the archive. --check marks the tasks\n      whose source address no longer resolves as stale.\n\n  learn solve [--split train|test] [--limit N] [--snapshot ID]\n      Solve stored tasks and record graded attempts. Default split: train.\n\n  learn status\n      The flag, entries by kind and status, candidates awaiting approval, and\n      the latest run.\n\n  learn report [--run ID] [--json]\n      Pass rates before and after, kept and pending entries, rejections with\n      reasons, budget, child runs and reflections. Default: the latest run.\n\n  learn bootstrap | improve | approve | export | render\n      Not implemented yet.\n\nProgress goes to stderr; the report goes to stdout.";
