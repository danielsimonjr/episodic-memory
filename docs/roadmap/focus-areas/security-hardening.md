# Focus area: Security hardening

> Threat model for episodic-memory, what's already mitigated on the fork,
> and the systematic sweep that should follow.

## The data this plugin touches

Episodic-memory indexes **every Claude Code and Codex conversation** on
The user's machine. Conversations regularly contain:

- API keys, tokens, OAuth secrets pasted for debugging
- Internal company details, customer names, financial data
- Source-code paths revealing project structure
- Personal info — names, emails, projects, schedules
- File-system paths revealing the user's directory layout

The DB at `~/.config/superpowers/conversation-index/db.sqlite` and the
archive at `~/.config/superpowers/conversation-archive/` are
**plaintext** today. **Anyone with read access to those paths can
reconstruct the user's entire AI-coding history.**

This isn't unique to episodic-memory — the underlying Claude Code
session JSONL is also plaintext at `~/.claude/projects/`. But
episodic-memory aggregates and indexes for search, which makes the
data more useful — both to the user AND a potential attacker.

## Threat model

| Threat | Severity | Mitigation today | Status |
|---|---|---|---|
| **Prompt injection → MCP `read` reads arbitrary files** | HIGH | Fork hardened: `read` confined to archive dir + `.jsonl` extension | ✅ Closed (`6cadc20`) |
| **Malicious conversation JSONL → RCE during parse/index** | MEDIUM | Parser uses `JSON.parse` (safe); no eval; no shell construction | ✅ Not exploitable as audited 2026-05-18 |
| **Malicious conversation JSONL → embeddings inject** | LOW | Embedder is text-only; no model-side code injection vector | ✅ Not exploitable |
| **DB at rest readable by other local users** | MEDIUM | Filesystem perms (Windows ACL / Unix umask) | ⚠️ User-dependent; no plugin-level enforcement |
| **DB exfiltration via backup** | MEDIUM | None — backups (Dropbox, Time Machine) inherit plaintext | ⚠️ Documented; user awareness |
| **Hook script env-var hijack (`PLUGIN_ROOT`)** | LOW | Falls back to `CLAUDE_PLUGIN_ROOT`; both injected by Claude Code | ⚠️ Trust boundary is Claude Code |
| **Secrets accidentally indexed → embedded into model** | MEDIUM | None today; embedder is local but data still embeds | ⚠️ Open work |
| **Hook script silently fails, leaving index stale** | LOW | None today | 🔧 In `now.md` |
| **MCP tool can be called by ANY agent that connects** | MEDIUM | MCP framework has no per-tool authz | ⚠️ Architectural; needs upstream MCP support |

## Mitigations we've shipped (fork)

### `read` tool path traversal closed
**Commit:** `6cadc20`

Was: tool accepted any `params.path` string with only `existsSync`.
Now: resolved path must lie inside `getArchiveDir()` AND end in `.jsonl`.
Verified: all legitimate `archive_path` values come from
`path.join(projectArchive, file)` rooted in the archive dir, so this is
non-breaking.

### SQL injection: not exploitable (audit confirmation)
**No code change; verification only**

All `db.prepare()` calls use `?` placeholders; template-string SQL only
interpolates a hardcoded column-list constant (`EXCHANGE_SELECT_COLUMNS`
in `search.ts:56`). Verified across all 5 files using DB exec/prepare
during the May 2026 audit.

### Hardcoded secrets: none present (audit confirmation)
**No code change; verification only**

Grep for token-shape regexes (`sk-`, `npm_`, `gh[pousr]_`, `AKIA`,
`AIza`, JWT, Slack tokens) returned zero hits in `src/`, `cli/`,
`scripts/`, `test/`.

## What's still open

### 1. Secret-aware indexing
**Severity: MEDIUM** · **Effort: medium**

Conversations contain secrets. The embedder is local (Xenova MiniLM
runs on-device), so secrets don't leave the machine. BUT:

- The embedding vectors are derived from the secret-containing text;
  a partial reconstruction attack on the embeddings is theoretical but
  not impossible
- Future cloud embedders (theme E in [later.md](../later.md)) would
  exfiltrate secrets
- Search results return the literal exchange text — a prompt-injection
  attack could ask the agent to "search for my API keys" and the agent
  would happily oblige

**Proposal:** opt-in `redactSecrets` mode that runs a regex pass over
exchange text before embedding and search-return, replacing token-shaped
substrings with `[redacted]`. Stored separately so toggle is reversible.
Default off (most users don't need it); on-by-default for users who
opt in via config.

### 2. DB encryption at rest
**Severity: MEDIUM** · **Effort: high**

`better-sqlite3` doesn't support SQLCipher natively. Options:

- Switch to `@journeyapps/better-sqlite3-multiple-ciphers` (drop-in with
  encryption support). Cost: rebuild deps, dep maturity question.
- Encrypt at the filesystem layer (BitLocker, FileVault, dm-crypt) and
  document instead of bundling. Cost: pushes the work to the user.
- Per-row encryption of just the sensitive columns (user/assistant
  messages). Cost: complexity, can't search encrypted columns.

Recommendation: document filesystem-layer encryption as the primary
mitigation; offer SQLCipher as an opt-in for high-security users.

### 3. MCP tool authorization
**Severity: MEDIUM** · **Effort: depends on upstream MCP spec**

The MCP protocol today has no per-tool authorization. Any client that
connects to the server can call `search` and `read`. This is fine in
The user's single-user setup but a real concern for:

- Multi-tenant deployments (not the user's case)
- Shared machines (still a concern)
- Compromised agents that get redirected to call dangerous tools

**Proposal:** monitor MCP spec evolution. If the protocol adds
capability negotiation or scopes, adopt them. Until then, this is
architectural — outside the fork's scope to fix alone.

### 4. Audit of write paths
**Severity: LOW-MEDIUM** · **Effort: small**

The fork hardened `read`. The `write` surface in the plugin is:

- DB writes (insert/update via parameterized SQL) — safe
- Archive file writes (`fs.copyFileSync(sourcePath, archivePath)`) — `sourcePath` is from filesystem scan, not user input; safe
- Summary file writes — same provenance; safe
- `*.embedding-migration.lock` file — own PID only

But: the `summarizer.ts` makes outbound HTTP requests to the Claude
API. Audit:

- TLS verification on?
- API key from env var only (not file)?
- No HTTP fallback?

**Proposal:** quick audit pass, write findings to a new `docs/security.md`
threat-model document.

### 5. Hook integrity
**Severity: LOW** · **Effort: small**

`hooks/hooks.json` runs a node script on every SessionStart. If an
attacker can write to that file, they have arbitrary code execution.
But: `~/.claude/plugins/cache/` is user-writable, so an attacker who
can write there can do anything. The hook itself isn't the weakest link.

**Proposal:** document that the user trusts their plugin install dir,
no code change needed.

## A written threat model document

The above should be consolidated into `docs/security.md`. Structure:

1. **Asset inventory** — what data this plugin holds
2. **Trust boundaries** — who can touch what
3. **Threat enumeration** — table above, expanded
4. **Mitigations shipped + planned**
5. **User-side hardening guide** — filesystem encryption, antivirus exclusions, etc.
6. **Incident response** — if you suspect compromise, what to do

This is a `next.md` Theme 7 deliverable.

## Audit tooling

The May 2026 audit was largely manual + targeted grep. For future
audits:

- **`gitleaks scan`** — pre-built tool for hardcoded-secret detection
- **`npm audit`** — already in use; clean as of 2026-05-18
- **`snyk test`** — third-party for transitive dep CVEs; could
  supplement npm audit
- **Manual RLM pass** — for codebase-wide pattern checks (the
  May 2026 audit pattern). Re-run before any major dep bump or schema
  change.

## See also

- [`../now.md`](../now.md) — current security-relevant work
- [`../next.md`](../next.md) § Theme 7 — Security hardening (continued)
- [`/CLAUDE.md`](../../../CLAUDE.md) § Critical gotchas — operational details
