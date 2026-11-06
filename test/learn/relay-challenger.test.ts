import { describe, it, expect } from 'vitest';
import { parseIdCitedLines } from '../../src/learn/cited-ids.js';
import { redactLearnedText } from '../../src/learn/knowledge-gate.js';

/**
 * Relay-challenger findings for PR #21 (Task 2). These tests are expected to
 * FAIL on the current head; each one pins a defect found by adversarial
 * review. They are not part of the plan's Step-1 suite.
 */

const HEX_A = 'a'.repeat(32);
const HEX_UNKNOWN = 'f'.repeat(32);
const HEX_DIGITS = '0123456789abcdef'.repeat(2);

const RESOLVE = {
  exchange: (id: string) =>
    id === HEX_A
      ? {
          ref: { id, path: '/archive/p/s.jsonl', lineStart: 1, lineEnd: 2, sessionId: 's' },
          text: 'alpha service stores tokens in the vault',
        }
      : null,
  attempt: () => false,
};

describe('relay challenger: citation gate', () => {
  it('drops a mid-line citation whose id does not resolve (spec §7 rule 4)', () => {
    // The mark group is only honoured at end-of-line; a mark mid-line is left
    // in the body unvalidated and is not added to sources.
    const body = `compare [#${HEX_UNKNOWN}] with how the alpha service stores tokens in the vault [#${HEX_A}]`;
    const out = parseIdCitedLines(body, RESOLVE, 3);
    expect(out.lines.join('\n')).not.toContain(HEX_UNKNOWN);
  });

  it('protects every 32-hex mark from the PII redactor, not only the trailing group', () => {
    // redactLearnedText splits off only the trailing mark group, so a mark
    // appearing mid-line is fed to redactPii, whose 10-19 digit-run patterns
    // destroy it.
    const out = redactLearnedText(
      `compare [#${HEX_DIGITS}] with alpha service stores tokens in the vault [#${HEX_A}]`,
      { redactPii: t => t.replace(/\d{10,19}/g, 'x'.repeat(10)) }
    );
    expect(out).toContain(HEX_DIGITS);
  });
});
