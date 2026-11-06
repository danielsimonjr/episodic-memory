/**
 * Bootstrapping: map the archive's projects and propose the first knowledge.
 *
 * Spec §6.1. The run has four stages, and each one is a gate rather than a
 * formality:
 *
 * 1. **Bootstrappers.** One isolated subprocess per eligible project, in
 *    parallel under a bound. Each gets the four read-only tools plus
 *    `propose_entry` and maps its corpus: periods, topics, the user's terms,
 *    what supersedes what, what is absent. It proposes one `navigation` skill
 *    and one `exploration-notes` skill.
 * 2. **Gates.** Every proposal goes through `gateEntry` with resolvers backed by
 *    the index database and `learning_attempt`; a failure is recorded on the run
 *    with its reason instead of being retried or repaired. The two bootstrap
 *    skills' cited lines are also mirrored into the project context — that copy
 *    feeds learner prompts only, never the rendered block, so nothing uncited
 *    can reach a session.
 * 3. **Merge.** One text call consolidates the candidates into a single global
 *    instruction in the template grammar. Each of its lines is also a heuristic,
 *    which is what makes a later `reinforce` meaningful.
 * 4. **Measurement.** Generate tasks if the archive has none, solve the signal
 *    train set first with an empty snapshot and then with the candidates, and
 *    decide with the paper's Figure 4 rule: keep a candidate when both sides
 *    graded the same number of tasks, the pass rate does not fall, and either
 *    mean turns or USD per task falls by at least
 *    `EPISODIC_MEMORY_LEARN_MIN_SAVING`. An unmeasured or partially measured
 *    candidate stays a candidate.
 *
 * A spend cap stops the run (`stopped`) and keeps everything already validated;
 * it does not throw away the bootstrapping work.
 *
 * Additive only: nothing here deletes an entry. A candidate that fails the gain
 * rule keeps its row and its validation record and waits for a human.
 */
import type Database from 'better-sqlite3';
import { type PassRate } from './learning-db.js';
import type { IdCitationResolver } from './cited-ids.js';
import { CallBudget } from './solver.js';
import { runAgent, type PidRegistry } from './agent-runner.js';
import type { LearnDbs } from './types.js';
/** The slug of the global instruction the merge step writes. */
export declare const BOOTSTRAP_INSTRUCTION_SLUG = "bootstrap-map";
/** The slug of the run's reflection. */
export declare const BOOTSTRAP_REFLECTION_SLUG = "bootstrap-reflection";
export interface BootstrapOptions {
    /** Test seam: defaults to `runAgent`. */
    runAgent?: typeof runAgent;
    /** Model for the bootstrapper subprocesses. */
    model?: string;
    /** Judge for a `recall` solve; unused by the signal set, passed through anyway. */
    judge?: (prompt: string) => Promise<string>;
    /** Cap on concurrent bootstrapper subprocesses. */
    concurrency?: number;
    /** Source exchanges per project for task generation. */
    perProject?: number;
    seed?: number;
    /** The run's shared call budget. */
    budget: CallBudget;
    /** Where a run records the subprocesses it owns. */
    pids?: PidRegistry;
    /** Text-only model for the merge and reflection calls. Defaults to `callLearnModel`. */
    textModel?: (prompt: string) => Promise<string>;
}
export interface BootstrapResult {
    runId: string;
    projects: number;
    /** Proposals the gates accepted and stored as candidates. */
    proposed: number;
    rejected: Array<{
        slug: string;
        reason: string;
    }>;
    /** Entry names this run activated. */
    activated: string[];
    /** Entry names left as candidates (awaiting a measured gain or a human). */
    pending: string[];
    before: PassRate;
    after: PassRate;
    status: 'done' | 'stopped';
}
/** One project's corpus shape, from the index alone. */
export interface ProjectStats {
    project: string;
    exchanges: number;
    sessions: number;
    first: string;
    last: string;
}
/**
 * Projects with at least `MIN_PER_PROJECT` indexed exchanges (spec §6.1 step 2).
 *
 * Deterministic order, and sidechains excluded: a project with a dozen
 * exchanges makes every one of its tasks trivially findable, and a sidechain is
 * not a conversation a user would search for.
 */
export declare function eligibleProjects(indexDb: Database.Database, minPerProject?: number): ProjectStats[];
/** An exchange resolver over the index database, for the citation gate. */
export declare function indexExchangeResolver(indexDb: Database.Database): IdCitationResolver['exchange'];
/**
 * The bootstrap gain rule: keep when the signal pass rate does not fall and mean
 * turns or USD per task fall by at least `minSavingPct`.
 *
 * Both sides must have been measured, and they must have graded the same number
 * of tasks. `passRate` counts only graded attempts, so an abort shrinks one
 * side's total. A smaller after side can be the easy tasks only; that is not
 * evidence the candidate saved turns at equal accuracy, and the candidate waits.
 */
export declare function bootstrapGain(before: PassRate, after: PassRate, minSavingPct: number): {
    keep: boolean;
    turnSavingPct: number;
    usdSavingPct: number;
    reason: string;
};
/**
 * Run the bootstrap.
 *
 * Everything the run needs is injected — `runAgent`, the text model, the budget
 * and the PID registry — so a test never reaches a model, a GPU or a subprocess.
 */
export declare function runBootstrap(dbs: LearnDbs, options: BootstrapOptions): Promise<BootstrapResult>;
