/**
 * Render and persist the learned block for every project that has active
 * entries, plus one shared `*` row.
 *
 * This module is on the `learn` CLI's slow path only: it needs the knowledge
 * store to list active entries, and it writes `learning.sqlite`. The hook never
 * imports it — it reads the rows this function wrote (spec §6.3).
 */
import type Database from 'better-sqlite3';
import type { KnowledgeStore } from './knowledge-store.js';
import { type RedactFn, type ScreenFn } from './learn-inject.js';
/**
 * Render one block per project that has active entries and one for `*`.
 *
 * Upsert, not insert: the block is derived output, so re-rendering replaces the
 * previous text for that project. `rendered_at` is rewritten so a later reader
 * can tell how stale the text is.
 */
export declare function writeLearnedBlocks(store: KnowledgeStore, learningDb: Database.Database, maxChars: number, opts?: {
    screen?: ScreenFn;
    redact?: RedactFn;
}): Promise<void>;
