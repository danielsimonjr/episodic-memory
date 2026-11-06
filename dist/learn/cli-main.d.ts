/**
 * The `learn` subcommands. Reached only from `src/learn-cli.ts`, which owns the
 * early exits (guard, flag, GPU reservation, priority) so this module can load
 * the heavy stack without slowing those down.
 *
 * Every command that changes knowledge or spends money runs under `.learn.lock`,
 * and every command that spends money computes its baseline first and refuses to
 * start when the baseline alone exceeds `EPISODIC_MEMORY_LEARN_MAX_CALLS`
 * (spec §7 rule 10a). A run that cannot afford its own measurement has nothing
 * useful to say when it fails halfway.
 *
 * Progress goes to stderr and the report to stdout: `learn report > file` must
 * produce a file a human can read, and progress lines must never land in it.
 */
import type Database from 'better-sqlite3';
import { type SolveOptions } from './solver.js';
import type { LearnDbs } from './types.js';
/** Exit code for a subcommand a later task fills in. Distinct from a failure. */
export declare const NOT_IMPLEMENTED_EXIT = 3;
export interface LearnCliDeps {
    /** Open handles. When absent the CLI opens all three and closes them. */
    dbs?: LearnDbs;
    runAgent?: SolveOptions['runAgent'];
    model?: string;
    judge?: (prompt: string) => Promise<string>;
    /** Text model for task generation. Defaults to `callLearnModel`. */
    generateModel?: (prompt: string) => Promise<string>;
    now?: () => Date;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}
export declare const LEARN_USAGE = "Usage: episodic-memory learn <command> [options]\n\nSelf-improving memory over the conversation archive. Every command needs\nEPISODIC_MEMORY_LEARN=1; without it each exits 0 and does nothing.\n\nCOMMANDS:\n  learn tasks [--per-project N] [--seed S] [--check]\n      Generate self-practice tasks from the archive. --check marks the tasks\n      whose source address no longer resolves as stale.\n\n  learn solve [--split train|test] [--limit N] [--snapshot ID]\n      Solve stored tasks and record graded attempts. Default split: train.\n\n  learn status\n      The flag, entries by kind and status, candidates awaiting approval, and\n      the latest run.\n\n  learn report [--run ID] [--json]\n      Pass rates before and after, kept and pending entries, rejections with\n      reasons, budget, child runs and reflections. Default: the latest run.\n\n  learn bootstrap | improve | approve | export | render\n      Not implemented yet.\n\nProgress goes to stderr; the report goes to stdout.";
/**
 * The subprocess count a baseline needs: the signal tasks of the train split.
 *
 * `solve` spends one call per task; bootstrap solves the same set twice (empty
 * snapshot, then candidates), which is why its multiplier is 2.
 */
export declare function baselineCallCount(db: Database.Database, times?: number): number;
/** A refusal message when the baseline cannot be afforded, or null. */
export declare function baselineRefusal(count: number, maxCalls: number): string | null;
/**
 * Parse and run one `learn` subcommand.
 *
 * The returned number is the process exit code. `deps.dbs` is a test seam: a
 * real invocation opens and always closes its own handles.
 */
export declare function runLearnCli(argv: string[], deps: LearnCliDeps): Promise<number>;
