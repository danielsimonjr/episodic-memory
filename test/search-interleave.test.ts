import { describe, expect, it } from 'vitest';
import { interleaveByRank } from '../src/search.js';

const row = (id: string, distance?: number) => ({ id, distance });
const ids = (rows: Array<{ id: string }>) => rows.map(r => r.id);

describe('interleaveByRank, the merge of a both search', () => {
  it('alternates the vector and text rows and stops at the limit', () => {
    const merged = interleaveByRank([row('a', 0.1), row('b', 0.2), row('c', 0.3)], [row('d'), row('a')], 3);
    expect(ids(merged)).toEqual(['a', 'd', 'b']);
  });

  it('never returns more rows than the limit, also when both lists are full', () => {
    const vector = ['v1', 'v2', 'v3', 'v4'].map(id => row(id, 0.5));
    const text = ['t1', 't2', 't3', 't4'].map(id => row(id));
    expect(interleaveByRank(vector, text, 4)).toHaveLength(4);
    expect(interleaveByRank(vector, text, 1)).toHaveLength(1);
  });

  it('keeps the vector distance of a row that the text step ranks first', () => {
    const merged = interleaveByRank([row('a', 0.1), row('b', 0.4)], [row('b')], 2);
    expect(merged).toEqual([row('a', 0.1), row('b', 0.4)]);
  });

  it('fills the places from the longer list when the other list runs out', () => {
    expect(ids(interleaveByRank([row('a', 0.1)], [row('t1'), row('t2'), row('t3')], 3))).toEqual(['a', 't1', 't2']);
    expect(ids(interleaveByRank([], [], 5))).toEqual([]);
  });
});
