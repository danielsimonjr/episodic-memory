/**
 * The injection screen for learned text.
 *
 * Learned text is written by a model that read untrusted archive content, and
 * it is injected into every future session, exported to disk, and fed to every
 * later learner. This module is the barrier: it normalises the text first
 * (NFKC, control/zero-width/bidi characters removed) so a disguised payload
 * cannot slip past, then rejects a named list of shapes. The reason is the
 * name of the pattern that matched, so `learn report` can say why.
 *
 * It is a barrier, not a proof. Approval and grounding stand behind it.
 *
 * Imports nothing but the secret redactor, so the digest hook may use it.
 */
import type { KnowledgeKind } from './types.js';
export type ScreenResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** NFKC, then drop control, zero-width and bidi-override characters. */
export declare function normalizeForScreen(text: string): string;
export interface ScreenOptions {
    kind?: KnowledgeKind;
    field?: string;
}
/**
 * Screen one field of a learned entry. `text` is normalised here, so callers
 * pass the raw value.
 */
export declare function screenLearnedText(text: string, opts?: ScreenOptions): ScreenResult;
