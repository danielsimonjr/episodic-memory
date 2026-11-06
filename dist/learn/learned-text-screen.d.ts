/**
 * The injection screen for learned text.
 *
 * Learned text is written by a model that has just read untrusted archive
 * content, and it is then injected into every future session, exported to disk
 * and read by later learners. Every field of every kind therefore passes this
 * screen before storage and again on the way out.
 *
 * The screen is a barrier, not a proof: approval mode and the grounding check
 * stand behind it. Its reason strings are the names of the patterns below, so a
 * `learn report` line can say which rule fired.
 *
 * Imports only `../redact.js`, keeping the digest hook's fast path intact.
 */
/**
 * Declared locally rather than imported from `./types.js`: this module is on the
 * digest hook's fast path and must import nothing but `../redact.js`, and a type
 * import would still be a compile-time edge to the shared type module.
 */
export type ScreenKind = 'instruction' | 'skill' | 'reflection';
export interface ScreenOptions {
    kind?: ScreenKind;
    field?: string;
}
export type ScreenResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Normalise text before any pattern runs: NFKC folds fullwidth and other
 * compatibility forms into ASCII, then the invisible characters an attacker uses
 * to split a keyword are removed.
 */
export declare function normalizeForScreen(text: string): string;
/**
 * Screen one field of learned text.
 *
 * Every field passes the same pattern set, case-insensitively, on the
 * normalised text. With `kind: 'instruction'` and `field: 'body'` each line must
 * additionally match one of the template forms, so an instruction cannot smuggle
 * free prose into the always-loaded block.
 */
export declare function screenLearnedText(text: string, opts?: ScreenOptions): ScreenResult;
