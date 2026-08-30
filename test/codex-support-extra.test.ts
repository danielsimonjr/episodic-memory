import { describe, it, expect } from 'vitest';
import {
  compareSemver,
  parseCodexCliVersion,
  versionMeetsMinimum,
  codexVersionRequirementMessage,
  MIN_CODEX_VERSION,
} from '../src/codex-support.js';

describe('codex-support helpers', () => {
  it('parses and compares semver, including short versions', () => {
    expect(parseCodexCliVersion('codex-cli 0.130.1 (build)')).toBe('0.130.1');
    expect(parseCodexCliVersion('no version here')).toBeUndefined();
    expect(compareSemver('1.2.3', '1.2.3')).toBe(0);
    expect(compareSemver('1.3.0', '1.2.9')).toBeGreaterThan(0);
    expect(compareSemver('1.2', '1.2.1')).toBeLessThan(0);
    expect(versionMeetsMinimum('0.130.0')).toBe(true);
    expect(versionMeetsMinimum('0.129.0')).toBe(false);
  });

  it('explains the version floor when parsing fails or succeeds', () => {
    expect(codexVersionRequirementMessage('')).toContain(MIN_CODEX_VERSION);
    expect(codexVersionRequirementMessage('codex-cli 0.1.0')).toContain('found 0.1.0');
  });
});
