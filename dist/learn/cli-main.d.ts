/**
 * The `learn` subcommands. Reached only from `src/learn-cli.ts`, which owns the
 * early exits (guard, flag, GPU reservation, priority) so this module can load
 * the heavy stack without slowing those down.
 *
 * Every command that changes knowledge or spends money runs under `.learn.lock`,
 * and every command that spends money computes its baseline first and refuses to
 * start when the baseline alone exceeds `EPISODIC_MEMORY_LEARN_MAX_CALLS`
 * (spec §7 rule 10a). A run that cannot afford its own measurement has nothing
 * useful to say when it fails halfway. Spending past that precheck — the solve
 * set is larger than the signal baseline — stops the run (`stopped`) and keeps
 * the attempts already stored.
 *
 * Progress goes to stderr and the report to stdout: `learn report > file` must
 * produce a file a human can read, and progress lines must never land in it.
 */
import type { Database } from '../sqlite.js';
import { type SolveOptions } from './solver.js';
import { LEARN_USAGE } from './usage.js';
import type { LearnDbs } from './types.js';
/** Exit code for a subcommand a later task fills in. Distinct from a failure. */
export interface LearnCliDeps {
    /** Open handles. When absent the CLI opens all three and closes them. */
    dbs?: LearnDbs;
    runAgent?: SolveOptions['runAgent'];
    model?: string;
    judge?: (prompt: string) => Promise<string>;
    /** Text model for task generation. Defaults to `callLearnModel`. */
    generateModel?: (prompt: string) => Promise<string>;
    /**
     * Checks that a Claude Code executable is usable. Throws `ClaudeBinError` when none is.
     * Defaults to `claudeExecutableOption()`.
     */
    claudePreflight?: () => void;
    now?: () => Date;
    stdout: (text: string) => void;
    stderr: (text: string) => void;
}
export { LEARN_USAGE };
/**
 * The subprocess count a baseline needs: the signal tasks of the train split.
 *
 * `solve` spends one call per task.
 * Bootstrap solves the same set twice, once with an empty snapshot and once with the candidates.
 * The bootstrap multiplier is therefore 2.
 */
export declare function baselineCallCount(db: Database, times?: number): number;
/** A refusal message when the baseline cannot be afforded, or null. */
export declare function baselineRefusal(count: number, maxCalls: number): string | null;
/**
 * A unified diff of two texts, `---`/`+++` headers and one hunk.
 *
 * The function is deliberately small.
 * The two sides are one entry body, so a full-file hunk is what a reviewer wants to read anyway.
 * An LCS over a handful of lines is enough to mark the changed ones.
 */
export declare function unifiedDiff(before: string, after: string, label: string): string;
/**
 * Parse and run one `learn` subcommand.
 *
 * The returned number is the process exit code. `deps.dbs` is a test seam: a
 * real invocation opens and always closes its own handles.
 */
export declare function runLearnCli(argv: string[], deps: LearnCliDeps): Promise<number>;
