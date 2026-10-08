import type Database from 'better-sqlite3';
export type DigestTier = 'session' | 'day' | 'week';
export interface DigestEntry {
    id: number;
    tier: DigestTier;
    project: string;
    periodStart: string;
    periodEnd: string;
    text: string;
    sources: string[];
    model: string;
    createdAt: string;
    supersededBy: number | null;
    handoff: boolean;
}
type NewDigestEntry = Omit<DigestEntry, 'id' | 'createdAt' | 'supersededBy'>;
/** Create the digest tables. Idempotent. Entries are never deleted; compression sets superseded_by. */
export declare function ensureDigestSchema(db: Database.Database): void;
/** Insert one entry. Returns its id, or null when the (tier, project, period_start) key already exists. */
export declare function insertDigestEntry(db: Database.Database, e: NewDigestEntry): number | null;
/** Entries that no compressed entry has replaced, newest period first. */
export declare function listActiveEntries(db: Database.Database, project: string): DigestEntry[];
/** Active, non-handoff entries of one tier across all projects, oldest first. Input for compression. */
export declare function listActiveByTier(db: Database.Database, tier: DigestTier): DigestEntry[];
/** Mark entries as replaced by another entry. Rows stay in the table. */
export declare function supersede(db: Database.Database, ids: number[], byId: number): void;
/** Full-text search over active entries. Never throws on FTS syntax characters. */
export declare function searchDigest(db: Database.Database, query: string, project?: string, limit?: number): DigestEntry[];
export {};
