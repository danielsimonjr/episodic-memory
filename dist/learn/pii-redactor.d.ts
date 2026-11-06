/**
 * PII redaction for learned text.
 *
 * Dependency-free on purpose: the knowledge store, the `skills` tool and the
 * export all call `redactPii` on the way out, and none of them should pay for
 * anything heavier than five regular expressions to do it.
 *
 * The patterns are deliberately biased toward false positives: a learned line
 * that loses a number it did not need to lose is cheaper than one that leaks a
 * card number into every future session.
 */
interface PiiPattern {
    name: string;
    regex: RegExp;
    replacement: string;
}
export declare const PII_PATTERNS: readonly PiiPattern[];
/** Replace email, SSN, card, phone and IPv4 shapes with typed placeholders. */
export declare function redactPii(text: string): string;
export {};
