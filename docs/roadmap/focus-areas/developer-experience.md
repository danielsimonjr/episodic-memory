# Focus area: Developer experience

> For Daniel-the-maintainer and for users who hit problems, how does
> episodic-memory feel? Today: moderately confusing. The plan to make
> it pleasant.

## Two audiences

This focus area covers two related but distinct experiences:

1. **Maintainer DX** — Daniel (or anyone working ON the fork) building,
   testing, debugging, releasing. Internal-facing.
2. **User DX** — Daniel-the-user (or anyone installing the plugin) on
   first run, configuring, recovering from errors. External-facing.

Both matter; they're addressed together because the work overlaps.

## Maintainer DX — current pain points

### Slow test suite

- Full suite: ~2 min on Windows (mostly cold-start cost)
- `npm test` does a prebuild step (`generate-version.js`) even when nothing changed
- `npx vitest run <file>` is much faster but loses suite-level reporting

**Fixes:**
- Single-test workflow: `npx vitest run test/<file>.test.ts` (already works; document)
- Pre-warm script: `npm run test:warm` that runs once to cache the embedder
- Vitest workspace config that splits "fast unit" vs "slow integration"

### `npm run build` rebuilds everything from scratch

`tsc` + `esbuild` regenerate all dist files even when only one src
file changed. On Windows + my git autocrlf config, this produces 40+
phantom "modified" files in git status.

**Fixes:**
- `.gitattributes` setting `dist/* text eol=lf` to force LF endings
  consistently across platforms
- Investigate `tsc -b` (project references) for incremental compilation
  (probably overkill for this codebase size)

### CHANGELOG.md is a manual chore

Every change needs a CHANGELOG entry. Easy to forget; easy to write
poorly.

**Fixes:**
- Pre-commit hook that warns if `CHANGELOG.md` wasn't touched
- Or: switch to `changeset`-style per-PR changelog fragments that get
  consolidated at release
- Or: just accept the manual work; it's already part of dev-workflow

### Upstream sync is manual

The merge dance from CLAUDE.md / upstream-sync.md works but takes
manual judgment each time. Could be automated for the no-conflict
case:

```bash
npm run upstream-sync
# checks for upstream changes, attempts merge,
# runs tests, prompts to commit/push
```

**Status:** nice-to-have. Daniel does this maybe once a month.

### "Why isn't my change being picked up?"

After editing `src/foo.ts`, you have to:
1. `npm run build` to update dist/
2. `/reload-plugins` in Claude Code to respawn the MCP server
3. Hope the failure cache doesn't bite you

It's enough steps that you sometimes forget one and waste time
debugging the wrong thing.

**Fixes:**
- A `npm run watch` that rebuilds on src/ change, prints "DON'T FORGET
  /reload-plugins" each time
- Doc on the "edit → test in Claude Code" loop

## Maintainer DX — proposed improvements

In rough priority order:

| Improvement | Effort | Payoff |
|---|---|---|
| `.gitattributes` for LF in dist/ | trivial | medium |
| Document the single-test workflow + cleanup race | trivial | medium |
| `npm run test:warm` to pre-cache embedder | small | high (tests get fast) |
| `npm run watch` for src/ changes | small | medium |
| `npm run upstream-sync` automation | medium | low (rare workflow) |
| `tsc -b` incremental | medium | low |
| Pre-commit CHANGELOG check | small | low (mostly habit) |

The first 4 are queued for `next.md` consideration; the rest are
parking-lot.

## User DX — current pain points

### "It just stopped working"

Most common user experience when something goes wrong. No surfacing
of why. Already covered in [observability.md](observability.md) — but
DX-wise:

- The first symptom is usually "search returns nothing useful"
- The cause is usually upstream (hook failed, embedder cache cold, etc.)
- The fix is usually one command if you know which

**The fix is `doctor`.** Make it the obvious first step:
- Mention in README ("If something seems off, run `npx episodic-memory doctor`")
- Mention in the SessionStart hook message ("Welcome — diagnostics at `doctor`")
- Make the `doctor` output actionable (suggest next commands)

### Install is slow + opaque

First-run takes 3-5 minutes (npm install of 250 packages + native
build). Two visible messages:

```
Installing episodic-memory dependencies (first run only)...
This may take 30-60 seconds...
```

But it takes 5x longer than "30-60 seconds." User gives up, kills the
process, comes back angry.

**Fix:** the wrapper should emit progress per-stage:
- `[1/4] Cloning plugin repo... (10s)`
- `[2/4] Installing 250 dependencies... (90s)`
- `[3/4] Building native bindings (better-sqlite3, onnxruntime)... (60s)`
- `[4/4] Verifying install... (5s)`
- `Ready!`

These can come from `npm install --foreground-scripts --loglevel=info`
piped through a filter.

### "Can I just turn it off temporarily?"

Sometimes you don't want every conversation indexed (sensitive
project, debugging the plugin itself, etc.). Today's only options:

- Set `CONVERSATION_SEARCH_EXCLUDE_PROJECTS=...` to exclude by project
  name (requires restart)
- Uninstall the plugin (drastic)

**Fix:** a runtime flag the SessionStart hook respects.
`~/.config/superpowers/.disabled` exists → hook is a no-op. Easy
on/off, no restart needed.

### "Where did my conversations go?"

If the user resets their `~/.config/superpowers/` (because of a
machine migration, or hitting issues), the conversation archive is
gone. They have to re-sync from scratch (which can take 30 min if they
have a year of history).

**Fix:**
- Periodic archive snapshot to `~/.config/superpowers/snapshots/`
- `doctor restore` from latest snapshot
- Document the snapshot location in user docs

### "Which version am I running?"

`/mcp` shows `name: episodic-memory, version: 1.4.0` (which is
`VERSION` from `src/version.ts`, derived from `package.json`). But:

- Doesn't say which marketplace (upstream vs fork)
- Doesn't say which install path
- Doesn't say if there are pending updates upstream

**Fix:** `doctor install` (queued in `now.md`) covers this. Also
include in MCP server's `instructions` field:
`Episodic Memory v1.4.0 (Daniel's fork — see ~/Dropbox/Github/episodic-memory)`.

## User DX — proposed improvements

In rough priority order:

| Improvement | Effort | Payoff |
|---|---|---|
| `doctor install` with structured output | small | high |
| Progress reporting from wrapper | small | high |
| `~/.config/superpowers/.disabled` quick-off | trivial | medium |
| Periodic archive snapshots + restore | medium | medium |
| README updates pointing to `doctor` | trivial | high (discoverability) |
| MCP server `instructions` field shows install context | trivial | low |

Already partially in `now.md`; the rest are in `next.md` Theme 1.

## "Walking the path" experience

The most important user moment is the **first 60 seconds** after a
fresh install. Today:

1. `/plugin install episodic-memory@local-marketplace` — opaque, ~3min
2. `/reload-plugins` — silent unless something fails
3. `/mcp` — either ✅ or ✗; ✗ gives no hint why
4. Search a conversation — works or doesn't

Ideal:

1. `/plugin install ...` — shows progress per phase
2. `/reload-plugins` — shows "episodic-memory: ready (X conversations indexed)"
3. `/mcp` — shows version + install path + last sync time
4. Search — works

Each step exists today; each could be 3x more communicative.

## Anti-goals

Things NOT to invest in here:

- **Glossy install UI** — terminal-only is fine
- **Onboarding tutorial** — over-engineered for a developer tool
- **Settings GUI** — the env-var + config-file approach is idiomatic
- **Cloud signup / accounts** — episodic-memory is local-only by
  design

## See also

- [`../now.md`](../now.md) § "doctor command: Windows install diagnostics"
- [`../next.md`](../next.md) § Theme 1 — Better first-run install story
- [`observability.md`](observability.md) — adjacent and reinforcing
- [`/CLAUDE.md`](../../../CLAUDE.md) § Common debugging recipes — operational details
