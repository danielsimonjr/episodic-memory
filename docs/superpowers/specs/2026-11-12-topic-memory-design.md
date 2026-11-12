# Topic memory: design and plan

Self-organized topic memory for episodic-memory, adapted from "Can LLM Agents Organize Their Own Memory?" (SOMEM; Fu, Qi et al., City University of Hong Kong and Tencent; code at github.com/Qi202/SoMem).

## 1. Source ideas and the selected subset

SOMEM keeps the original interactions (Source) unchanged. The agent writes linked Markdown documents (Topic) from them. Each Topic paragraph has a stable identifier. Each statement has a footnote with an event time and the Source records that support it. The runtime validates every staged edit and rejects the whole edit when a check fails. Code, not the model, derives a link graph, a timeline and a recent view from Topic.

The LoCoMo ablation (paper Table 5, overall 88.96%) gives the selection:

| Component | Change when removed | Decision |
|---|---|---|
| Source | -8.64 | Exists: the conversation archive and the `exchanges` table |
| Topic | -2.92 (interval excludes 0) | Build |
| Core | +0.00 | Leave out: the digest handoff notes do this job |
| Recent | -1.30 (within noise) | Leave out: the digest loads newest entries first |
| Timeline | -0.97 (within noise) | Build: derived by code, low cost |
| Graph | -0.91 (within noise) | Build backlinks only: derived by code, low cost, and the read path needs link resolution |

## 2. Scope

In scope:

1. A sync step that organizes the exchanges of finished sessions into the Topic documents of their project. The step uses the digest model call.
2. A validator that accepts or rejects one staged edit as a whole.
3. Derived tables for units, links and timeline events. The validator rebuilds them in the same transaction as the edit.
4. A `topics` MCP tool: list, read, search, links, timeline.

Out of scope: Core, Recent, a live-session edit tool, injection of topic text at session start, and a backfill of old sessions by default.

## 3. Storage

SQLite tables in the index database, created by `ensureTopicSchema(db)` (idempotent, like `ensureDigestSchema`):

| Table | Columns | Purpose |
|---|---|---|
| `topic_doc` | `project`, `slug`, `text`, `updated_at`; key (`project`, `slug`) | The documents. This is the only table that the model output writes. |
| `topic_unit` | `project`, `unit_id`, `slug`, `heading`, `text`, `seq`; key (`project`, `unit_id`) | Derived: one row for each paragraph. `seq` is the creation order: a kept unit keeps its value. |
| `topic_link` | `project`, `from_unit`, `to_unit` | Derived: one row for each paragraph reference. |
| `topic_event` | `project`, `unit_id`, `time`, `statement`, `sources` | Derived: one row for each footnote. `time` is `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. |
| `topic_unit_fts` | FTS5 over `unit_id UNINDEXED`, `project UNINDEXED`, `text` (`porter unicode61`) | Search. |
| `topic_session` | `project`, `session_id`, `status` (`pending`, `done`, `rejected`), `attempts`, `error`; key (`project`, `session_id`) | Progress. A session with a `done` or `rejected` row is not organized again. `pending` holds the failed-call count. |
| `topic_meta` | `key`, `value` | Holds `since`, the first-run time. |

Documents are stored in the database, not as files, so one transaction installs an edit and its derived tables. A rejected edit rolls back and leaves the prior state.

## 4. Document format

A document is Markdown. The slug is its name (`^[a-z0-9][a-z0-9-]{0,63}$`). Example:

```markdown
# Work history

## Employment

Joined A in May.[^1] Moved to B in August to work on [Orion](project.md#^7c91e2ab).[^2]
^4a8b10cd

[^1]: Time: 2026-05; Sources: #ex-111
[^2]: Time: 2026-08; Sources: #ex-222
```

- A paragraph is a block of text lines between blank lines, outside headings and footnote definitions. It is one unit.
- The line after the paragraph text holds its identifier `^` + 8 lowercase hex characters. A new paragraph from the model has no identifier, and the runtime assigns one (from a hash of project, slug and text, with a suffix change on collision).
- A footnote definition is `[^<label>]: Time: <time>; Sources: <ref>[, <ref>...]`. In model output, a ref is a mark number of the current prompt (`3`) or an exchange id already cited in the document (`#<id>`). The runtime rewrites each mark number to `#<exchange id>` before it stores the document.
- A link is `[text](<slug>.md#^<unit id>)`.
- The heading of a unit is the path of its headings, joined by ` > `.

## 5. The organize step

`runTopics(db, opts)` in `src/topic-job.ts`. It runs in `sync-cli.ts` after `runDigestPhase()`, through `runTopicPhase()`, which never throws.

1. Return at once unless `EPISODIC_MEMORY_TOPICS` is exactly `1`, or when `shouldSkipReentrantSync()` is true.
2. On the first run, store `since` = now in `topic_meta`. `EPISODIC_MEMORY_TOPICS_SINCE` (an ISO time) replaces it, to allow a backfill. This step comes before the GPU check, so that sessions that end during a deferred first run are not lost.
3. With the Ollama backend and the default model call, return with `deferred` when `gpuReservationBlock()` names a holder.
4. Select the sessions with a non-NULL `session_id` that started at or after `since`, have no `done` or `rejected` row, and are quiet (last exchange older than 30 minutes, the digest rule). Skip trivial sessions with the digest rule. Process the OLDEST first, so that the documents follow the order of events. Stop after `EPISODIC_MEMORY_TOPICS_MAX_SESSIONS` (default 3) attempts.
5. Build the prompt (`src/topic-prompts.ts`): the rules; the session exchanges numbered like the digest prompt, within `EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS` (default 24000; extend `buildSessionPrompt` with an optional cap argument, default unchanged); the inventory of every project document (slug, title, headings); and the full text of the documents that fit in `EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS` (default 24000), the most recently updated first. The prompt marks which documents are shown in full. The job records the `updated_at` of each shown document.
6. The model answers with zero or more blocks:

   ```
   === FILE <slug>
   <the complete new text of the document>
   === END
   === DELETE <slug>
   ```

   An answer with no block means that the session adds nothing. Record `done`.
7. Prepare, then validate. The order is fixed: parse the blocks, rewrite mark numbers to `#<exchange id>`, redact (`redactEntryText`), assign identifiers to new paragraphs, then run the checks of section 6 on that final text. The stored text is the validated text. When validation fails, call the model once more with the error list appended. When the second answer also fails, record `rejected` with the errors. A failed model call records nothing and counts in `failed`, so the next run retries the session. A failed call increments `attempts` on a `pending` row. After 3 failed calls for one session, record `rejected`.
8. Install the accepted edit in one transaction: first compare the `updated_at` of each shown document with the recorded value; on a mismatch, roll back, write no `topic_session` change and count the session as `stale` (the next run retries it). Otherwise write or delete the `topic_doc` rows, rebuild the derived tables of the project, write the FTS rows, record `done`.

Concurrency: `sync-cli.ts` holds the sync lock (`acquireLock(getSyncLockPath())`) for the whole run, and the phase runs inside it, so one writer exists. The MCP tool only reads. The `updated_at` check guards a future second writer.

`GpuReservedError` during a call stops the run with `deferred`, as in the digest.

## 6. Validation

The edit is checked against the project state AFTER the edit (the untouched documents plus the new ones). Every check that fails adds one error line. Any error rejects the whole edit.

1. Each slug matches the slug pattern. A slug appears in at most one block.
2. A `DELETE` names an existing document.
3. A `FILE` or `DELETE` block names a new slug or a document whose full text was in this prompt. The model cannot replace or remove a document it did not read.
4. Each document has exactly one level-1 heading, on its first non-blank line.
5. Each paragraph has at least one footnote reference, and each reference has a definition in the same document. Each definition is referenced.
6. Each footnote time matches `YYYY`, `YYYY-MM` or `YYYY-MM-DD` with a valid month and day.
7. Every source ref resolves: a mark number of the current prompt, or `#<id>` of an exchange in the `exchanges` table of the same project.
8. Each paragraph identifier is unique in the project. An identifier given by the model must have the 8-hex form.
9. Each link resolves to an existing document and unit of the project after the edit. A deleted document must have no inbound link.
10. A document is at most `EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS` (default 8000). The project holds at most `EPISODIC_MEMORY_TOPICS_MAX_DOCS` (default 50) documents.
11. Evidence is kept: every exchange id cited anywhere in the project before the edit is still cited somewhere in the project after it. Merges and regroupings pass; a rewrite that drops evidence fails. This protects the Source links, the component that the ablation shows matters most.

Secrets are redacted in the prepare step (section 5, step 7). That is a rewrite, not a check.

## 7. The `topics` MCP tool

Schema in `src/mcp-schemas.ts`, handler in `src/topic-tool.ts`, registration in `src/mcp-server.ts` and `src/mcp-tools.ts`. `project` defaults to the project of the working directory (`projectKeyFromCwd`). One action for each call:

| Action | Arguments | Result |
|---|---|---|
| `list` | `project` | The slug, title and unit count of each document |
| `read` | `project`, `slug` | The document text |
| `search` | `query`, optional `project`, `from`, `to` | Matching units (FTS5), with slug, heading, unit id, text and the event times in the range |
| `links` | `project`, `unit` | Outgoing links and backlinks of the unit, each with slug, heading and text |
| `timeline` | `project`, optional `from`, `to` | Events by time, each with its statement, unit and source ids |

A source id resolves to an archive path and line range through the existing `digest` `expand` action. The tool reads only. When the flag is off and no table exists, the tool says that topic memory is off.

Server constraints (repo `CLAUDE.md`, gotchas 1 and the `skills` pattern):

- `mcp-tools.ts` imports `topic-tool.ts` lazily, inside the `topics` branch, so a session that never calls the tool loads nothing of the feature.
- Every module reachable from the server writes logs to stderr only.
- The tool opens no write path: it never calls `ensureTopicSchema`. When the tables do not exist, it answers that topic memory has no documents yet.
- The tool reads no new environment variable, so `.mcp.json` needs no new line. Topic text passes `redactEntryText` again on the way out.

## 8. Configuration

Every value has one default, in `src/constants.ts`:

| Variable | Default |
|---|---|
| `EPISODIC_MEMORY_TOPICS` | unset (off) |
| `EPISODIC_MEMORY_TOPICS_SINCE` | the first-run time |
| `EPISODIC_MEMORY_TOPICS_MAX_SESSIONS` | 3 |
| `EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS` | 24000 |
| `EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS` | 24000 |
| `EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS` | 8000 |
| `EPISODIC_MEMORY_TOPICS_MAX_DOCS` | 50 |

An invalid value falls back to the default, as `EPISODIC_MEMORY_DIGEST_MAX_SESSIONS` does.

## 9. Plan (tests first in each task)

| # | Task | Files | Tests |
|---|---|---|---|
| 1 | Parser and serializer: documents to units, footnotes, links; identifier assignment | `src/topic-format.ts` | Round trip; paragraph split; heading path; a new paragraph gets an identifier; collision suffix |
| 2 | Validator: checks 1-11 with one error line each | `src/topic-validate.ts` | One failing case and one passing case for each check; the error list for a mixed edit |
| 3 | Schema, install transaction, derived rebuild, queries | `src/topic-db.ts` | Install then read back; a rejected edit leaves every table unchanged; `seq` kept for a kept unit; FTS search; backlinks; timeline range |
| 4 | Prompt and answer parser | `src/topic-prompts.ts` | Block parse (FILE, DELETE, empty, junk outside blocks ignored, unterminated block is an error); mark numbering reused |
| 5 | Job and phase, sync wiring | `src/topic-job.ts`, `src/topic-phase.ts`, `src/sync-cli.ts`, `src/constants.ts`, `src/digest-prompts.ts` (cap argument) | Flag off writes nothing; `since` stored before a GPU deferral; GPU reserved defers; NULL `session_id` skipped; stale `updated_at` retried; an edit to an unshown document rejected; oldest first; quiet and trivial skips; retry with errors then `rejected`; model failure retried next run, `rejected` after 3; `since` respected |
| 6 | MCP tool | `src/mcp-schemas.ts`, `src/topic-tool.ts`, `src/mcp-tools.ts`, `src/mcp-server.ts` | Each action; default project; off message; strict schema refuses unknown arguments |
| 7 | Docs | `README.md`, `docs/SCHEMA.md`, `docs/architecture/`, `CHANGELOG.md`, `CLAUDE.md` (tool count, reachable modules, `src/` tree), `skills/remembering-conversations/MCP-TOOLS.md`; tests that list tool names (grep `test/` for `'skills'`) | Doc gates |

Gates: `bun run typecheck`, the full vitest suite, `bun run build` (commits `dist/`), the two doc gates (`repo-tools check . --docs=docs/architecture`, `repo-tools docs check src`), `repo-tools clones`, the junior STE pass on new docs and comments.

## 10. Relay route

Coordinator and planner: Opus. Plan reviewer: Fable (advisor). Worker: Haiku builds each task from this plan, tests first. Challenger: Haiku reads the worker diff, critiques the choices and proposes alternatives (read-only). Reviewer: Sonnet selects or combines, with probes. Fixer: Opus. The coordinator runs the gates, opens one PR, gates CI on the head commit and merges.

## 11. Risks

- The model may rewrite a statement wrongly while it keeps the citation. Check 11 stops lost evidence, not wrong wording (the paper names the same limit). The citation lets a reader check the statement against the exchange.
- A small local model may fail the format often. The `rejected` count measures this; the retry carries the exact errors.
- Prompt injection from conversation text: topic text is never injected into a session, only returned by an explicit tool call, and it is redacted.
