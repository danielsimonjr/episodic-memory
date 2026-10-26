import { describe, it, expect } from 'vitest';
import { syncHeadline } from '../src/sync-banner.js';

describe('syncHeadline', () => {
  it('reports a healthy run when nothing waits for a summary', () => {
    expect(syncHeadline({ pendingSummaries: 0, summarized: 3, summariesDeferred: '' })).toEqual(['\n✅ Sync complete!']);
  });

  it('reports a stalled queue as an unhealthy run', () => {
    const lines = syncHeadline({ pendingSummaries: 4, summarized: 0, summariesDeferred: '' });

    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('Sync finished WITHOUT SUMMARISING ANYTHING - 4 conversation(s) still need summaries.');
    expect(lines[1]).toContain('NOT a healthy run');
  });

  it('reports a wait for the shared GPU as a wait, not a fault', () => {
    const lines = syncHeadline({
      pendingSummaries: 4,
      summarized: 0,
      summariesDeferred: 'fleet GPU reserved by Starship',
    });

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('Sync finished; summaries deferred (fleet GPU reserved by Starship). 4 conversation(s) stay queued.');
    expect(lines[0]).not.toContain('WITHOUT SUMMARISING');
  });

  it('counts a run that wrote some summaries before the wait as complete', () => {
    expect(
      syncHeadline({ pendingSummaries: 4, summarized: 1, summariesDeferred: 'fleet GPU reserved by Starship' })
    ).toEqual(['\n✅ Sync complete!']);
  });
});
