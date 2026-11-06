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
export const PII_PATTERNS = [
    {
        name: 'email',
        regex: /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
        replacement: '<EMAIL>',
    },
    {
        name: 'ssn',
        // U.S. SSN: 3-2-4 digits with dashes. Not a validator.
        regex: /\b\d{3}-\d{2}-\d{4}\b/g,
        replacement: '<SSN>',
    },
    {
        name: 'credit-card',
        // 13-19 unbroken digits, or 3-5 four-digit groups joined by space or dash.
        regex: /\b(?:\d{13,19}|\d{4}(?:[ -]\d{4}){2,4})\b/g,
        replacement: '<CC>',
    },
    {
        name: 'phone',
        // North American phone: optional country code, area code, 7 digits, any common separators.
        regex: /(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/g,
        replacement: '<PHONE>',
    },
    {
        name: 'ipv4',
        // Dotted quad. Over-matches (300.300.300.300) on purpose.
        regex: /\b(?:\d{1,3}\.){3}\d{1,3}\b/g,
        replacement: '<IP>',
    },
];
/** Replace email, SSN, card, phone and IPv4 shapes with typed placeholders. */
export function redactPii(text) {
    let out = text;
    for (const pattern of PII_PATTERNS) {
        pattern.regex.lastIndex = 0;
        out = out.replace(pattern.regex, pattern.replacement);
    }
    return out;
}
