/**
 * The gate every proposal passes before it may be stored.
 *
 * Pipeline (spec §7 rules 3, 4, 6, 7):
 *
 * 1. the slug must be portable (`isValidSlug`),
 * 2. `redactSecrets` runs on every text field,
 * 3. `parseIdCitedLines` keeps only lines with resolving, grounded marks,
 * 4. `redactPii` runs on each kept line body and on the title, description and
 *    scope — never on the trailing mark group, whose 32-hex ids would trip the
 *    digit-run patterns,
 * 5. `screenLearnedText` runs on the slug, title, description, scope and body,
 * 6. the scope must be non-empty and the confidence in the enum,
 * 7. `steps`, when present, must hold known actions and string parameters.
 *
 * Pure: no SDK, no memoryjs, no database. The resolvers and the PII redactor
 * are injected by the caller, so this runs in tests without a store.
 */
import { type IdResolvers } from './cited-ids.js';
import type { LearnConfig } from './learn-config.js';
import { type NewKnowledgeEntry, type ProposedEntry } from './types.js';
export interface GateDeps {
    resolve: IdResolvers;
    redactPii: (text: string) => string;
    config: Pick<LearnConfig, 'minGrounding'>;
    runId: string;
}
export type GateResult = {
    entry: NewKnowledgeEntry;
    attempts: number[];
} | {
    rejected: string;
};
/**
 * Redact one field: secrets first, then PII.
 *
 * A body is handled line by line so the trailing mark group is split off
 * before the PII patterns run. `PiiRedactor`'s phone and card patterns match
 * any run of 10 to 19 digits, and a 32-hex exchange id is exactly such a run.
 */
export declare function redactLearnedText(text: string, deps: {
    redactPii: (text: string) => string;
}): string;
/** Gate one proposal into a storable candidate, or explain the rejection. */
export declare function gateEntry(proposal: ProposedEntry, deps: GateDeps): GateResult;
