# Combined Memory Digest Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a cited, size-bounded digest of past sessions that loads at session start, searchable on demand, beside the existing exchange index.

**Architecture:** A new `digest_entry` table (plus an FTS mirror) holds summaries written by the existing summarizer. A job runs after sync, writes session entries, then compresses day and week tiers by marking older entries superseded. A second SessionStart hook prints the digest. A new MCP tool `digest` reads and searches it. Nothing is ever deleted.

**Tech Stack:** TypeScript ESM, Bun (install, test, typecheck, bundle), Node at runtime, `better-sqlite3`, `sqlite-vec` (unchanged), vitest.

**Spec:** `docs/superpowers/specs/2026-10-07-combined-memory-design.md`

## Global Constraints

- Plugin name, id and install path stay `episodic-memory`.
- Source is TypeScript ESM. Shipped hook and server entry points run on `node`; no `bun` at runtime.
- Feature flag `EPISODIC_MEMORY_DIGEST` defaults off. Flag off: hook output is byte-identical to today.
- Size budget `EPISODIC_MEMORY_DIGEST_MAX_CHARS`, default `6000`; the oldest tier drops first.
- Tiers are exactly `session`, `day`, `week`. No code path deletes a digest entry, an exchange or a file; compression sets `superseded_by`.
- All text passes `redactSecrets` (`src/redact.ts`) before the summarizer and again before storage.
- A line without a valid citation is dropped. If no line survives, no entry is written.
- Summarizer: existing backends only (`claude` default model from `EPISODIC_MEMORY_API_MODEL`, default `haiku`; `ollama` when configured). Child Claude processes inherit `EPISODIC_MEMORY_SUMMARIZER_GUARD` (`src/reentrancy.ts`).
- The injection hook must not import `@huggingface/transformers` or `sqlite-vec`.
- Clean-room: no code, prompt text or file layout from the `remember` plugin (Community License).
- `dist/` is committed; rebuild with `bun run build` and commit only real content changes.
- Decisions on the spec's open questions: the digest is indexed in FTS and searchable (tool `digest`); the per-day cap before compression is `EPISODIC_MEMORY_DIGEST_DAY_CAP`, default `5`; the Ollama backend is supported in the first release through the existing backend switch.
- Redaction of digest text always runs (`redactSecrets`), independent of the opt-in used for the exchange index, because the digest is injected into new sessions.
- Days and weeks are UTC. Only past days and finished weeks compress; the week rule uses `EPISODIC_MEMORY_DIGEST_WEEK_CAP`, default `2`.
- The digest step runs from `src/sync-cli.ts` through `src/digest-phase.ts`, after the embedding-migration phase, with a lazy import (the CLI keeps heavy modules out of the early-exit path).

## Review Focus

- A transcript with a secret in it: the secret appears in no stored entry, no injected text and no search result.
- A model answer that cites mark `[99]` when the session has 4 exchanges: that line is dropped.
- A project with no digest yet: the hook prints nothing and exits 0 (new installs, flag on).
- A digest larger than the budget: output length is at most `EPISODIC_MEMORY_DIGEST_MAX_CHARS` and ends on a whole line.
- Two syncs racing (two sessions start together): no duplicate entry (unique key on `tier, project, period_start`).
- A failed or timed-out summarizer call: no entry, sync still exits 0, the next run retries.
- The digest hook runs while `EPISODIC_MEMORY_SUMMARIZER_GUARD` is set: it prints nothing (no recursion).

---

### Task 1: Schema and storage

**Files:**
- Create: `src/digest-db.ts`
- Modify: `src/db.ts` (`migrateSchema` calls `ensureDigestSchema`)
- Test: `test/digest-db.test.ts`

**Interfaces:**
- Produces:
  - `type DigestTier = 'session' | 'day' | 'week'`
  - `interface DigestEntry { id: number; tier: DigestTier; project: string; periodStart: string; periodEnd: string; text: string; sources: string[]; model: string; createdAt: string; supersededBy: number | null; handoff: boolean }`
  - `ensureDigestSchema(db: Database.Database): void` (creates `digest_entry` and `digest_fts`; idempotent)
  - `insertDigestEntry(db, e: Omit<DigestEntry,'id'|'createdAt'|'supersededBy'>): number | null` (null when the unique key `tier, project, period_start` exists)
  - `listActiveEntries(db, project: string): DigestEntry[]` (not superseded, newest first)
  - `supersede(db, ids: number[], byId: number): void`
  - `searchDigest(db, query: string, project?: string, limit?: number): DigestEntry[]`

- [ ] **Step 1: Write failing tests** `creates schema twice without error`, `insert returns null on duplicate key`, `supersede keeps rows and hides them from listActiveEntries`, `searchDigest finds a word in text`, `migrateSchema on a legacy db creates digest tables`.
- [ ] **Step 2: Run** `bun run test -- test/digest-db.test.ts`. Expected: FAIL (module missing).
- [ ] **Step 3: Implement** the table (`id INTEGER PRIMARY KEY`, columns as `DigestEntry`, `sources` JSON text, `handoff INTEGER DEFAULT 0`, `UNIQUE(tier, project, period_start)`) and an FTS5 table `digest_fts(text, content='digest_entry', content_rowid='id')` kept in step by insert and supersede paths. Call `ensureDigestSchema` from `migrateSchema` after `ensureFts`.
- [ ] **Step 4: Run** the test file and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): add digest_entry schema and storage`.

### Task 2: Citation parsing and validation

**Files:**
- Create: `src/digest-validate.ts`
- Test: `test/digest-validate.test.ts`

**Interfaces:**
- Produces:
  - `parseCitedLines(raw: string, marks: ReadonlyMap<number, string>): { lines: string[]; sources: string[]; dropped: number }`. A model line looks like `fact text [3,5]`. `marks` maps a prompt mark number to an exchange id. The parser keeps a line only when it has at least one `[n,...]` group and every n is in `marks`. It strips the group and returns the ids in `sources` (deduplicated, in order). `lines` keep their `[n]` marks rewritten as the stable form `[#<exchangeId>]`.
  - `redactEntryText(text: string): string` (wraps `maybeRedactSecrets`).

- [ ] **Step 1: Write failing tests** `keeps a line with a valid mark`, `drops a line with no mark`, `drops a line citing an unknown mark`, `keeps valid marks and drops a line mixing a valid and an unknown mark` (the whole line drops), `dedupes sources`, `redacts a planted token`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** both functions; the rule for a mixed line is stated in the test name above.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): validate citations and redact entry text`.

### Task 3: Summarizer entry point

**Files:**
- Modify: `src/summarizer.ts` (export `callDigestModel`)
- Create: `src/digest-prompts.ts`
- Test: `test/digest-prompts.test.ts`

**Interfaces:**
- Consumes: the internal `callModel(prompt: string): Promise<string>` at `src/summarizer.ts:276` (backend and model choice, guard env, fallback model).
- Produces:
  - `callDigestModel(prompt: string): Promise<string>` (thin export of `callModel`)
  - `buildSessionPrompt(exchanges: ConversationExchange[]): { prompt: string; marks: Map<number, string> }` (numbers exchanges from 1; text is redacted first and truncated to a fixed character cap)
  - `buildCompressPrompt(entries: DigestEntry[], tier: 'day' | 'week'): { prompt: string; marks: Map<number, string> }` (marks map to source exchange ids already cited by the entries)

- [ ] **Step 1: Write failing tests** `session prompt numbers exchanges from 1 and maps each to its id`, `session prompt contains no planted secret`, `compress prompt marks resolve to the union of entry sources`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement.** Prompts instruct: one fact per line, end each line with `[n,...]` marks, no marks means the line is discarded, no speculation. `callDigestModel` only re-exports; add no new network target.
- [ ] **Step 4: Run** the file and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): prompts and summarizer entry point`.

### Task 4: Digest job (session entries)

**Files:**
- Create: `src/digest-job.ts`
- Test: `test/digest-job.test.ts`

**Interfaces:**
- Consumes: Tasks 1 to 3; `exchanges` rows (`session_id`, `project`, `timestamp`, `id`).
- Produces: `runDigest(db: Database.Database, opts?: { model?: (p: string) => Promise<string>; now?: Date; dayCap?: number }): Promise<{ written: number; skipped: number; failed: number }>`. `opts.model` defaults to `callDigestModel` and exists so tests pass a fake. Behavior: returns zeros at once when `EPISODIC_MEMORY_DIGEST` is not `1` or when `shouldSkipReentrantSync()` is true. For each session without a `session` entry (key: project plus session start), build the prompt, call the model, parse, redact, insert. A thrown model call counts as `failed` and writes nothing.

- [ ] **Step 1: Write failing tests** with a fake model: `flag off returns zeros and writes nothing`, `guard env set returns zeros`, `writes one session entry with valid sources`, `second run writes no duplicate`, `all-invalid answer writes nothing`, `model throw counts failed and does not throw`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** `runDigest`; trivial sessions (one exchange under 100 characters) are skipped, matching `summarizeConversation`.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): session entry job`.

### Task 5: Day and week compression

**Files:**
- Modify: `src/digest-job.ts`
- Test: `test/digest-compress.test.ts`

**Interfaces:**
- Consumes: Task 4 `runDigest`, Task 3 `buildCompressPrompt`.
- Produces: `runDigest` also compresses. Rule: when a project has more than `dayCap` (default `EPISODIC_MEMORY_DIGEST_DAY_CAP` = `5`) active `session` entries on one calendar day (local time), write one `day` entry, `sources` = union, then `supersede` those sessions. The same rule, with cap `7` day entries, makes a `week` entry (ISO week).

- [ ] **Step 1: Write failing tests** `six session entries become one day entry and all six are superseded but still present`, `five stay as they are`, `day entry sources equal the union`, `eight day entries become one week entry`, `compression is idempotent`, `a failed compress call leaves the originals active`.
- [ ] **Step 2: Run** the file. Expected: FAIL.
- [ ] **Step 3: Implement** compression after session writing in the same `runDigest` call.
- [ ] **Step 4: Run** the file. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): day and week compression`.

### Task 6: Injection builder and hook

**Files:**
- Create: `src/digest-inject.ts`, `cli/digest-hook.js`
- Modify: `hooks/hooks.json`
- Test: `test/digest-inject.test.ts`, extend `test/hooks.test.ts`

**Interfaces:**
- Produces:
  - `buildDigestText(db, project: string, maxChars: number): string` (order: handoff entry, today, last 7 days, older weeks; stops before the next whole entry would exceed `maxChars`; each line keeps its `[#id]` marks; header line names the drill-down: call `read` with the exchange id)
  - `cli/digest-hook.js`: reads the hook JSON on stdin for `cwd`, derives the project key the same way `sync` does, prints `{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"<text>"}}` when the flag is on and the text is non-empty, otherwise prints nothing; always exits 0; prints nothing when the guard env is set.
  - `hooks.json`: a second command under the same `SessionStart` matcher, running `node "${PLUGIN_ROOT:-${CLAUDE_PLUGIN_ROOT}}/cli/digest-hook.js"`.

- [ ] **Step 1: Write failing tests** `output length never exceeds maxChars and ends on a whole line`, `oldest tier drops first`, `superseded entries are absent`, `empty digest returns empty string`, `hooks.json has both commands`, `hook prints nothing with the flag off`, `hook prints nothing with the guard set`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement** both. The hook imports only `better-sqlite3`, `dist/digest-db.js`, `dist/digest-inject.js` and path helpers.
- [ ] **Step 4: Run** the files plus `bun run test -- test/hooks.test.ts`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): session-start injection hook`.

### Task 7: Wire into sync, handoff note, MCP tool

**Files:**
- Create: `src/digest-phase.ts`, `src/digest-tool.ts`
- Modify: `src/sync-cli.ts` (call `runDigestPhase` after sync, errors caught and logged), `src/mcp-schemas.ts`, `src/mcp-tools.ts`, `src/mcp-server.ts` (register tool)
- Test: `test/digest-mcp.test.ts`, `test/digest-sync.test.ts`

**Interfaces:**
- Produces:
  - MCP tool `digest`: input `{ query?: string; project?: string; limit?: number; handoff?: string }`. No `query` and no `handoff`: returns `buildDigestText` for the project. With `query`: returns `searchDigest` hits with their `[#id]` marks. With `handoff`: stores a `session` entry with `handoff = 1` (redacted, one line, at most 500 characters, key `tier=session, project, period_start=now`); that entry sorts first in the injection.
  - `runDigestPhase(opts?): Promise<DigestResult | null>`: null when the flag is off or on error; never throws.

- [ ] **Step 1: Write failing tests** `digest tool returns text for a project`, `digest tool searches`, `handoff is redacted and capped at 500 characters`, `handoff entry appears first in the built text`, `sync with flag off never calls runDigest`, `sync survives a runDigest throw`.
- [ ] **Step 2: Run** the files. Expected: FAIL.
- [ ] **Step 3: Implement.** Follow the existing tool pattern in `src/mcp-tools.ts` (auth assertion first, lazy `import()`), and the Zod schema style in `src/mcp-schemas.ts`.
- [ ] **Step 4: Run** `bun run test` (whole suite) and `bun run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(digest): sync wiring, handoff note and digest tool`.

### Task 8: Docs, build, release notes

**Files:**
- Modify: `docs/SCHEMA.md`, `README.md`, `CHANGELOG.md`, `todo.md`; rebuild `dist/`
- Test: `bun run build`, `bun run test`, `bun run typecheck`

- [ ] **Step 1:** Document the tables, the three env settings (`EPISODIC_MEMORY_DIGEST`, `_DIGEST_MAX_CHARS`, `_DIGEST_DAY_CAP`), the tool and the hook in `docs/SCHEMA.md` and `README.md` as current design only (no dates or versions).
- [ ] **Step 2:** Add a `[Unreleased]` Added entry to `CHANGELOG.md`; tick the digest rows in `todo.md`.
- [ ] **Step 3:** Run `bun run build`. Expected: exit 0; `git status` shows only real `dist/` changes.
- [ ] **Step 4:** Run `bun run test` and `bun run typecheck`. Expected: all pass.
- [ ] **Step 5: Commit** `docs(digest): schema, settings and changelog`.
- [ ] **Step 6: Smoke test on a real database copy.** Copy the live db to a temp path, set `TEST_DB_PATH`, run `EPISODIC_MEMORY_DIGEST=1 node cli/episodic-memory.js sync` with the `claude` backend on 3 recent sessions, then run `node cli/digest-hook.js < {"cwd":"..."}`. Expected: valid JSON with cited lines, length under the budget.
