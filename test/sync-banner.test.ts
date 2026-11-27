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

  it('prints no success line for a run whose index write failed', () => {
    const lines = syncHeadline({ pendingSummaries: 0, summarized: 0, summariesDeferred: '', errorCount: 2 });
    expect(lines).toEqual(['\n⚠️  Sync finished; 2 file(s) not indexed. The error lines are on stderr.']);
  });
});

describe('outageWarningLine', () => {
  it('names the host and the count for an Ollama outage deferral', async () => {
    const { ollamaOutageHost } = await import('../src/ollama-backend.js');
    const { outageWarningLine } = await import('../src/sync-banner.js');
    const detail = 'Ollama endpoint http://127.0.0.1:11434 is unreachable: connect ECONNREFUSED 127.0.0.1:11434';
    const line = outageWarningLine(ollamaOutageHost(detail), 7);
    expect(line).toContain('http://127.0.0.1:11434');
    expect(line).toContain('7 conversation(s)');
  });

  it('gives no line for a deferral that is not an outage', async () => {
    const { ollamaOutageHost } = await import('../src/ollama-backend.js');
    const { outageWarningLine } = await import('../src/sync-banner.js');
    expect(outageWarningLine(ollamaOutageHost('fleet GPU reserved by Starship'), 3)).toBeNull();
    expect(outageWarningLine(ollamaOutageHost(''), 3)).toBeNull();
  });
});
