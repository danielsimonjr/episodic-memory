/**
 * The injection screen for learned text.
 *
 * A model that has just read untrusted archive content writes the learned text.
 * The plugin then injects this text into every future session, exports it to disk, and
 * gives it to later learners. Every field of every kind therefore passes this
 * screen before storage and again on the way out.
 *
 * The screen is a barrier, not a proof: approval mode and the grounding check
 * stand behind it. Its reason strings are the names of the patterns below, so a
 * `learn report` line can say which rule fired.
 *
 * Imports only `../redact.js`, keeping the digest hook's fast path intact.
 */
/**
 * The module declares `ScreenKind` locally rather than importing it from `./types.js`.
 * The module is on the digest hook's fast path and must import nothing but
 * `../redact.js`. A type import would still be a compile-time edge to the shared
 * type module.
 */
export type ScreenKind = 'instruction' | 'skill' | 'reflection';
/**
 * Options for screenLearnedText. The template check runs only when `kind` is `instruction` and `field` is `body`.
 */
export interface ScreenOptions {
    /** The kind of the learned text. */
    kind?: ScreenKind;
    /** The name of the field that the text fills. */
    field?: string;
}
/**
 * The outcome of a screen. `ok` is true when the text passes. Otherwise `reason` names the rule that rejected the text.
 */
export type ScreenResult = {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/**
 * Normalise text before any pattern runs.
 * NFKC folds fullwidth and other compatibility forms into their standard equivalents.
 * The function then removes the invisible characters that an attacker uses to split a keyword.
 */
export declare function normalizeForScreen(text: string): string;
/**
 * Screen one field of learned text.
 *
 * Every field passes the same pattern set, case-insensitively, on the
 * normalised text. With `kind: 'instruction'` and `field: 'body'`, each line must
 * also match one of the template forms. The template forms stop an instruction from
 * smuggling free prose into the always-loaded block.
 */
export declare function screenLearnedText(text: string, opts?: ScreenOptions): ScreenResult;
