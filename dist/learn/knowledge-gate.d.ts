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
 * The module is pure. No SDK, no memoryjs and no database import lives here: the
 * resolvers, the PII redactor and the config all come from the caller, so this
 * file is safe to load from a test or a hook.
 */
import type { NewKnowledgeEntry, ProposedEntry } from './types.js';
import { type IdCitationResolver } from './cited-ids.js';
import type { LearnConfig } from './learn-config.js';
export interface GateDeps {
    resolve: IdCitationResolver;
    redactPii: (text: string) => string;
    config: Pick<LearnConfig, 'minGrounding'>;
    runId: string;
}
export interface GateAccepted {
    entry: NewKnowledgeEntry;
    attempts: number[];
}
export type GateResult = GateAccepted | {
    rejected: string;
};
/**
 * Redact one text field: secrets first, then PII, with the trailing mark group
 * split off so the digit-run patterns never see a 32-hex exchange mark.
 */
export declare function redactLearnedText(text: string, deps: {
    redactPii: (t: string) => string;
}): string;
/**
 * Gate one proposal. Returns the entry to store, or the reason it was rejected
 * (the reason string is what `learn report` prints).
 */
export declare function gateEntry(proposal: ProposedEntry, deps: GateDeps): GateResult;
