import { describe, it, expect } from 'vitest';
import { compareByProject, compareByProjectAndKind } from '../../src/learn/entry-order.js';

type Row = { project: string; slug: string; kind: string };
const row = (project: string, slug: string, kind = 'skill'): Row => ({ project, slug, kind });
const slugs = (rows: Row[]) => rows.map(r => `${r.project}/${r.slug}`);

describe('compareByProject', () => {
  it('puts project rows before global rows, then orders by project and slug', () => {
    const rows = [row('*', 'a'), row('b-proj', 'z'), row('a-proj', 'y'), row('a-proj', 'x'), row('*', '0')];
    expect(slugs([...rows].sort(compareByProject))).toEqual(['a-proj/x', 'a-proj/y', 'b-proj/z', '*/0', '*/a']);
  });

  it('returns 0 for the same project and slug', () => {
    expect(compareByProject(row('p', 's'), row('p', 's'))).toBe(0);
  });

  it('ignores the kind', () => {
    expect(compareByProject(row('p', 'a', 'skill'), row('p', 'b', 'instruction'))).toBeLessThan(0);
  });
});

describe('compareByProjectAndKind', () => {
  it('puts project rows first, then orders instruction, skill, reflection, then project and slug', () => {
    const rows = [
      row('*', 'g', 'instruction'),
      row('p', 'c', 'reflection'),
      row('p', 'b', 'skill'),
      row('q', 'a', 'skill'),
      row('p', 'a', 'instruction'),
    ];
    expect(slugs([...rows].sort(compareByProjectAndKind))).toEqual(['p/a', 'p/b', 'q/a', 'p/c', '*/g']);
  });

  it('sorts an unknown kind after the known kinds and never returns NaN', () => {
    const unknown = row('p', 'a', 'not-a-kind');
    const known = row('p', 'z', 'reflection');
    expect(Number.isNaN(compareByProjectAndKind(unknown, known))).toBe(false);
    expect(compareByProjectAndKind(unknown, known)).toBeGreaterThan(0);
    expect(compareByProjectAndKind(known, unknown)).toBeLessThan(0);
    expect(slugs([unknown, row('p', 'b', 'skill'), known].sort(compareByProjectAndKind))).toEqual(['p/b', 'p/z', 'p/a']);
  });
});

describe('the callers', () => {
  it('use the shared orders and keep no copy of their own', async () => {
    const { readFileSync } = await import('fs');
    const callers: Array<[string, string]> = [
      ['../../src/learn/cli-main.ts', 'compareByProject'],
      ['../../src/learn/export.ts', 'compareByProject'],
      ['../../src/learn/knowledge-db.ts', 'compareByProjectAndKind'],
      ['../../src/learn/learned-block.ts', 'compareByProjectAndKind'],
    ];
    for (const [file, name] of callers) {
      const source = readFileSync(new URL(file, import.meta.url), 'utf-8');
      expect(source, file).toContain(`import { ${name} } from './entry-order.js'`);
      expect(source, file).toContain(`.sort(${name})`);
      expect(source, file).not.toMatch(/function (compareForStatus|orderForExport|compareEntries|orderForBlock)\b/);
      expect(source, file).not.toContain('KIND_ORDER');
    }
  });
});
