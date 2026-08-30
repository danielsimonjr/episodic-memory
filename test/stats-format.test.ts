import { describe, it, expect } from 'vitest';
import { formatStats } from '../src/stats.js';

describe('formatStats', () => {
  it('renders counts, missing-summary percentage, dates, and top projects', () => {
    const text = formatStats({
      totalConversations: 10,
      conversationsWithSummaries: 7,
      conversationsWithoutSummaries: 3,
      totalExchanges: 42,
      dateRange: {
        earliest: '2026-01-01T00:00:00.000Z',
        latest: '2026-08-01T00:00:00.000Z',
      },
      projectCount: 2,
      topProjects: [
        { project: 'alpha', count: 6 },
        { project: '', count: 4 },
      ],
      databaseSize: '12.0 KB',
    });
    expect(text).toContain('Total Conversations: 10');
    expect(text).toContain('30.0% missing summaries');
    expect(text).toContain('Date Range:');
    expect(text).toContain('Unique Projects: 2');
    expect(text).toContain('alpha');
    expect(text).toContain('(unknown)');
  });
});
