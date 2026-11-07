/**
 * PII redaction for learned text.
 *
 * This module has no dependencies, on purpose. The knowledge store, the `skills` tool and
 * the export all call `redactPii` on the way out. None of them should pay for anything
 * heavier than five regular expressions to do it.
 *
 * The patterns deliberately lean toward false positives. For a learned line, losing a number
 * that is not needed costs less than leaking a card number. A leaked card number reaches
 * every future session.
 */
/** One PII pattern: a name, the expression that finds it, and the text that replaces it. */
interface PiiPattern {
    name: string;
    regex: RegExp;
    replacement: string;
}
export declare const PII_PATTERNS: readonly PiiPattern[];
/** Replace email, SSN, card, phone and IPv4 shapes with typed placeholders. */
export declare function redactPii(text: string): string;
export {};
