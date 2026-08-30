# Security model

Threat model and mitigations for **episodic-memory**. This is the living
document promised in `docs/roadmap/focus-areas/security-hardening.md`.

## What the plugin stores

The index (`conversation-index/db.sqlite`) and archive (`conversation-archive/`)
hold every indexed Claude Code and Codex conversation: source, decisions,
pasted tokens, and filesystem paths. Anyone who can read those directories can
reconstruct the user's coding-agent history.

Underlying harness transcripts (`~/.claude/projects/`, `~/.codex/sessions/`)
are also plaintext. Episodic-memory aggregates them, which raises the value of
a single stolen copy.

## Threats and status

| Threat | Status | Mitigation |
|---|---|---|
| Prompt injection → MCP `read` of arbitrary files | Closed | Archive prefix + `.jsonl` + `realpath` + byte cap (`src/archive-path.ts`) |
| Search summary sidecar escape via poisoned `archive_path` | Closed | `safeArchiveSummaryPath()` |
| Secret redaction bypass via MCP `read` | Closed | `maybeRedactSecrets` on read output when `EPISODIC_MEMORY_REDACT_SECRETS=1` |
| Malicious JSONL → RCE | Not exploitable | `JSON.parse` only; no `eval` / shell construction |
| SQL injection on MCP search | Not exploitable | Bound `?` parameters; FTS phrase-quoted |
| Unsafe summarizer API URL | Closed | `https:` or localhost `http:`; no embedded credentials |
| Stdio JSON-RPC corruption | Closed | MCP-reachable modules log to stderr only |
| World-readable new dirs / DB | Closed (best-effort) | Dirs `0700`, DB `0600` |
| MCP tool call by any stdio client | Opt-in | Set `EPISODIC_MEMORY_MCP_TOKEN`; callers pass `auth_token` |
| Secrets indexed by default | Opt-in | `EPISODIC_MEMORY_REDACT_SECRETS=1` |
| DB / archive encryption at rest | Documented | See below — filesystem encryption, not SQLCipher |

## Encryption at rest

`better-sqlite3` does not speak SQLCipher. Bundling
`@journeyapps/better-sqlite3-multiple-ciphers` would be a native-dep fork with
maturity and rebuild cost on every platform this plugin supports.

**Recommended mitigation:** encrypt the volume that holds the config dir
(`EPISODIC_MEMORY_CONFIG_DIR`, or `~/.config/superpowers` / the fork's
`~/.claude/episodic-memory-data`):

- macOS: FileVault
- Windows: BitLocker
- Linux: LUKS / dm-crypt

Backups (Time Machine, Dropbox, restic) inherit whatever encryption the source
volume has. If you copy the archive or DB off-box, treat the copy as plaintext
secrets.

Optional SQLCipher remains a future opt-in for high-security users; it is not
the default path.

## MCP authorization

The MCP protocol has no per-tool scopes. By default any process that can spawn
the stdio server can call `search` and `read`.

To require a shared secret:

```bash
export EPISODIC_MEMORY_MCP_TOKEN='a-long-random-value'
```

Tool calls must then include `auth_token` matching that value. Comparison is
constant-time. Leave the env unset for the normal single-user Claude Code /
Codex install.

## Hook integrity

`hooks/hooks.json` runs `cli/sync-hook.js` on SessionStart. An attacker who can
write the plugin install dir already has code execution; the hook is not a
weaker link than the install itself. Failures are appended to `sync-errors.log`
and surfaced by `episodic-memory doctor`.

## Reporting

File issues on the fork or upstream. Do not attach live transcripts that
contain secrets.
