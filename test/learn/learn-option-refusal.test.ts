import { describe, expect, it } from 'vitest';
import { LEARN_OPTIONS_BY_COMMAND, learnOptionRefusal } from '../../src/learn/usage.js';

describe('learnOptionRefusal', () => {
  it('accepts every option that a subcommand reads, as --name value and as --name=value', () => {
    expect(learnOptionRefusal('tasks', ['--seed', '3', '--per-project=2', '--check'])).toBeUndefined();
    expect(learnOptionRefusal('report', ['--run', 'abc', '--json'])).toBeUndefined();
    expect(learnOptionRefusal('approve', ['learned:skill:p:s:v1', '--yes'])).toBeUndefined();
  });

  it('refuses an unknown option, an option of another subcommand and a short option, naming the argument', () => {
    expect(learnOptionRefusal('tasks', ['--zzz'])).toContain('unknown option --zzz for learn tasks');
    expect(learnOptionRefusal('status', ['--json'])).toContain('--json');
    expect(learnOptionRefusal('solve', ['-l', '3'])).toContain('-l');
  });

  it('leaves an unknown subcommand to the caller', () => {
    expect(learnOptionRefusal('nope', ['--zzz'])).toBeUndefined();
  });

  it('has a row for each implemented subcommand', () => {
    expect(Object.keys(LEARN_OPTIONS_BY_COMMAND).sort()).toEqual(
      ['approve', 'bootstrap', 'export', 'improve', 'render', 'report', 'solve', 'status', 'tasks'],
    );
  });
});
