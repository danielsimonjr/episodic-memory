# Focus area: Windows correctness

> Why this matters, what we've shipped, what's still broken, and the
> longer-term plan for making episodic-memory a first-class Windows
> citizen.

## Why this is a fork-level priority

Daniel primarily develops on Windows. Upstream's Windows support is
"works for some users" — labeled `platform:windows` on several issues
(#49, #78). The fork already shipped 2 platform fixes; more hide in
corners that only emerge under real Windows usage.

## What's shipped on the fork

| Fix | Commit | Symptom on Windows before |
|---|---|---|
| Path separator in `parseConversationFile` | `6cadc20` | Every conversation indexed with `project='unknown'` instead of the real project name |
| stdio MCP protocol corruption (5 `console.log` → `console.error`) | `6cadc20` | First-run-after-upgrade silently broke; `× failed` in `/mcp` with no obvious cause |
| Wrapper sentinel check for `node_modules` health | `443db0e` | Partial install (better-sqlite3 missing native binding) wasn't detected |
| `onnxruntime-common` hoist | `443db0e` | Transformers couldn't resolve `onnxruntime-common` bare import |
| `safeRmSync` in tests | `6cadc20` | Test cleanup EPERM on SQLite WAL files |

## Open Windows concerns (not yet investigated)

These are hypotheses to verify, not confirmed bugs:

### 1. Long-path support

Windows has a 260-char path limit by default. Our archive path is
`%USERPROFILE%\.config\superpowers\conversation-archive\<project>\<file>.jsonl`,
which is already 100+ chars before the project + filename. Long
project names + long conversation filenames could hit the limit and
throw `ENAMETOOLONG`.

**To investigate:** find a long-named project in the user's archive,
verify whether indexing/search/read of it works.

**Likely fix:** prefix paths with `\\?\` (Windows long-path namespace)
when length > 240 chars, OR enable `LongPathsEnabled` via the install
docs.

### 2. Locale & encoding

Indexed conversations contain Unicode (emoji, non-ASCII names). The
parser reads files with `utf-8` encoding explicitly — good. But
default Node behavior on Windows is to assume the system locale (often
cp1252 on US installs), and any code path that doesn't specify
encoding could mangle Unicode.

**To investigate:** `grep -rn "readFileSync\|writeFileSync" src/ | grep -v "utf-8\|utf8"` —
look for unguarded reads.

**Likely fix:** audit + add explicit `'utf-8'` everywhere.

### 3. CRLF line endings

The user's git config converts LF↔CRLF on checkout. After `npm run build`,
~40 dist files show as "modified" with line-ending-only diffs. That
pollutes `git status` and risks polluting commits.

**To investigate:** Add `.gitattributes` setting `dist/* text eol=lf`
to force LF on dist files regardless of platform.

**Likely fix:** ship the `.gitattributes` change, normalize the repo,
document in CLAUDE.md.

### 4. File-locking races

We already saw SQLite WAL EPERM (fixed with safeRmSync). Other places
that touch the filesystem under contention:

- `fs.rmSync` in CLI index rebuild
- Hook script (SessionStart sync) racing with manual sync
- The `.embedding-migration.lock` file — Windows locks are advisory by
  default; verify the lock acquisition is correct

**To investigate:** run a stress test with 3 concurrent CLI processes.

### 5. Process exit on stdin EOF

The mcp-server-wrapper handles SIGTERM/SIGINT/SIGHUP, but **Windows
doesn't deliver these signals** the same way Unix does. When Claude
Code closes the stdio pipe, the wrapper detects via
`process.stdin.on('end', ...)` — verify this works reliably on Windows
across all the Node versions we support.

Per the mcp-host plugin memory (`feedback_claude_code_mcp_failure_cache`
+ related): orphan-PID accumulation is a real problem on the user's
Windows machine. The plugin has a `/kill-plugins` panic button, but
that's a band-aid.

**To investigate:** spawn 5 mcp-server-wrapper instances, kill the
stdio for 3 of them, see if they all exit cleanly.

## Test strategy

Today's tests run on the developer's machine — so on the user's setup,
on Windows. That catches some bugs (the parser path-split bug DID show
up in `parser.test.ts` until we fixed it). But:

- CI runs upstream's tests on Linux only
- The fork has no CI yet (it's a personal project)
- The flaky Hook timeouts in `integration.test.ts` mask real
  Windows-specific regressions in the suite output

**Goal:** Make Windows test reliability ≥99% so a Windows regression
stands out. Concrete steps:

1. Pre-warm the embedding model before integration tests (fixes Hook
   timeout flake)
2. Add a Windows-specific test marker (`describe.skipIf(process.platform !== 'win32')`)
   for tests that exercise platform-specific code paths
3. Eventually: GitHub Actions CI matrix with Windows + macOS + Linux

## Documentation that should exist

- `docs/windows.md` — Installation gotchas, recovery commands, known
  limitations. Some content already lives in CLAUDE.md but a user-facing
  doc would help.
- Long-path enablement: how to turn on `LongPathsEnabled` for the user
  who hits it.
- Antivirus exclusions: real-time AV can slow `npm install` by 10x and
  hold file locks; mention this in the install docs.

## See also

- [`../now.md`](../now.md) § "Test stability: hook timeouts" — concrete near-term work
- [`../next.md`](../next.md) § Theme 1 — "Better first-run install story"
- [`/CLAUDE.md`](../../../CLAUDE.md) § Critical gotchas — operational details
