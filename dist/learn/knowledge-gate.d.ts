/**
 * The gate every proposal passes before it becomes stored knowledge.
 *
 * Pipeline, in this order and for the reasons the spec gives:
 *
 * 1. `isValidSlug` — the slug is an entity-name component and an export
 *    directory name, so it is validated before anything else touches it.
 * 2. `redactSecrets` on every text field — a secret must not reach storage even
 *    if a later check would have dropped the entry.
 * 3. `parseIdCitedLines` — citation and grounding, which also rewrites the marks
 *    and yields the `sources` the entry stores.
 * 4. `redactPii` on each surviving line body and on title, description and
 *    scope — after the mark group is off, because the PII phone and card
 *    patterns match any 10 to 19 digit run and a 32-hex mark can hold one.
 * 5. `screenLearnedText` on every field — the injection screen.
 * 6. Shape checks — non-empty scope, `confidence` in its enum, valid `steps`.
 *
 * The module is pure. No SDK, no store and no database import lives here: the
 * resolvers, the PII redactor and the config all come from the caller, so this
 * file is safe to load from a test or a hook.
 */
import type { NewKnowledgeEntry, ProposedEntry } from './types.js';
import { type IdCitationResolver } from './cited-ids.js';
import type { LearnConfig } from './learn-config.js';
/**
 * The dependencies that `gateEntry` needs. The caller supplies all of them, so this module imports no store or database.
 */
export interface GateDeps {
    resolve: IdCitationResolver;
    redactPii: (text: string) => string;
    config: Pick<LearnConfig, 'minGrounding'>;
    /** The id of the learning run that made the proposal. The stored entry records it. */
    runId: string;
}
/**
 * A proposal that passed every check. The entry starts as a `candidate` with trust `unverified`.
 *
 * `attempts` lists the attempt ids that the entry's kept lines cite.
 */
export interface GateAccepted {
    entry: NewKnowledgeEntry;
    attempts: number[];
}
/**
 * The result of `gateEntry`. It holds either an accepted entry or a `rejected` reason.
 *
 * A reason is a short code, such as `invalid-slug` or `no-cited-lines`.
 */
export type GateResult = GateAccepted | {
    rejected: string;
};
/**
 * Redact one text field: secrets first, then PII. The trailing mark group is
 * split off, and every earlier `#`/`@` mark is shielded, so the digit-run
 * patterns never see a 32-hex exchange mark.
 */
export declare function redactLearnedText(text: string, deps: {
    redactPii: (t: string) => string;
}): string;
/**
 * Gate one proposal. Returns the entry to store, or the reason it was rejected
 * (the reason string is what `learn report` prints).
 */
export declare function gateEntry(proposal: ProposedEntry, deps: GateDeps): GateResult;
