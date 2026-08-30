import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';

describe('plugin hook configuration', () => {
  it('uses a plugin root fallback that works in Codex and Claude Code', () => {
    const hooks = JSON.parse(
      readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf-8')
    );

    const command = hooks.hooks.SessionStart[0].hooks[0].command;

    expect(command).toBe('node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/cli/sync-hook.js"');
  });

  it('also syncs on compaction, because a long-lived session otherwise never archives', () => {
    // Without `compact`, archiving happens only at session boundaries. On a machine where
    // sessions run for days, that means the searchable history silently lags reality by
    // however long the session has been up — measured at 65 hours on 2026-08-08, with the
    // archived copy of the live session 4 MB behind the file on disk. Compactions are
    // frequent in exactly the long sessions that suffer, so they are the natural trigger.
    const hooks = JSON.parse(
      readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf-8')
    );

    const events = hooks.hooks.SessionStart[0].matcher.split('|');

    expect(events).toEqual(
      expect.arrayContaining(['startup', 'resume', 'clear', 'compact'])
    );
  });

  it('does not mark the hook async because Codex plugin hooks do not support async handlers yet', () => {
    const hooks = JSON.parse(
      readFileSync(new URL('../hooks/hooks.json', import.meta.url), 'utf-8')
    );

    const handler = hooks.hooks.SessionStart[0].hooks[0];

    expect(handler.async).toBeUndefined();
  });
});
