# Upstream sync strategy

> How **`danielsimonjr/episodic-memory`** stays current with
> **`obra/episodic-memory`** while carrying fork-specific patches.

This fork is a downstream — not a competing project. The goal is to ship
patches Daniel needs immediately while keeping the door open to merge
back upstream and consume future upstream improvements with minimal
divergence pain.

## Three-state ownership model

Every file in this fork is in one of three states:

| State | What it means | Where it lives |
|---|---|---|
| **Identical to upstream** | We haven't modified it; just rebuild artifacts may differ (line endings) | Most of `src/`, `cli/`, `scripts/`, `test/` |
| **Fork-patched (pending upstream PR)** | We've modified it; upstream may merge our patch eventually | `src/db.ts`, `src/parser.ts`, `src/mcp-server.ts`, `cli/mcp-server-wrapper.js`, `package.json`, `test/test-utils.ts`, `test/{db,verify,integration}.test.ts` |
| **Fork-only (won't be upstreamed)** | Daniel-specific, not relevant to upstream | `CLAUDE.md` (Daniel-rewrite), `todo.md`, `docs/roadmap/` |

The **fork-patched** set is the source of merge conflicts when pulling from
upstream. Keep that set as small as possible by upstreaming aggressively.

## The merge dance

Standard sync, when no conflicts expected:

```bash
cd ~/Dropbox/Github/episodic-memory
git fetch upstream
git log --oneline main..upstream/main          # what's new on obra
git diff main upstream/main -- src/             # which files changed
git merge upstream/main                          # straight merge, default branch
npm install                                      # deps may have shifted
npm run build                                    # rebuild dist/
npm test                                         # verify nothing regressed
git push origin main                             # publish to your fork
```

If conflicts arise (most likely in the fork-patched files above):

1. **Don't blindly accept upstream.** Our fork patches exist for a reason.
2. **Don't blindly keep ours.** Upstream may have improved the surrounding
   code or made our patch redundant.
3. **Read both sides + apply both.** For example, if obra changed
   `parseConversationFile` to add a new harness type, and our fork fixed
   the Windows path split, the merge should include both changes.
4. **Run the test suite.** Both old and new tests should pass after merge.
5. **Update CHANGELOG.md** with a "Merged upstream vX.Y.Z" entry under
   `[Unreleased]`.

## When upstream merges a fork patch

When obra accepts and merges a fork patch (or ships an equivalent), the
patch becomes redundant. Sequence:

1. Identify the upstream commit that obsoletes our patch (e.g., a PR
   merging the `read`-tool path-traversal fix).
2. **Revert the fork-only commit** that introduced our version of the
   patch, OR resolve the upcoming merge in favor of upstream's version.
3. Verify the upstream fix is at least equivalent (same surface,
   compatible behavior — read the upstream code).
4. Re-run `npm test`.
5. Update `CHANGELOG.md` with a "Fork patch X obsoleted by upstream vY.Y.Z merge"
   entry.
6. Update `CLAUDE.md` § "Why this fork exists — the 4 patches" table.

If upstream's version drifts from ours (different naming, different
defaults), preserve our version's behavior — they're functionally
equivalent for our users but a switch could surprise existing installs.

## How upstream changes get classified

When `git diff main upstream/main` shows something new, classify it:

- **Pure bugfix, doesn't conflict** → merge, ship.
- **Feature addition, no fork conflict** → merge, ship, add to CHANGELOG.
- **Feature addition that REPLACES a fork patch** → see "When upstream merges a fork patch" above.
- **Refactor of a fork-patched file** → manual merge; preserve both
  upstream's intent and our patch.
- **Breaking change to public API** → flag for slow rollout; consider
  delaying merge until fork users (Daniel) can adapt.

## Tracking upstream activity

Set up a lightweight watch on:

- **Releases:** `gh release list --repo obra/episodic-memory --limit 5`
- **Recent commits:** `git log upstream/main --oneline -20`
- **Open issues with our labels:** `gh issue list --repo obra/episodic-memory --label platform:windows,area:mcp-server`
- **Our PRs:** `gh issue list --repo obra/episodic-memory --author danielsimonjr`

Worth doing every 2 weeks or before any non-trivial fork work.

## Pull-request etiquette upstream

When opening PRs at `obra/episodic-memory`:

1. **One concern per PR.** Don't bundle Windows-fix + security-fix; obra
   wants to review and merge atomically.
2. **Reference the related issue** (or open one first if none exists).
3. **Include reproduction steps** for any bug fix.
4. **Match upstream code style** — single quotes, ESM `.js` import extensions,
   no `any` where avoidable.
5. **Don't change `dist/` in a PR** — upstream rebuilds. But DO mention
   that you've verified the build succeeds locally.
6. **Test coverage** — every PR adds or updates a test that demonstrates
   the bug or feature.

Our open PR #95 (the 4 fork patches) bundles for tracking purposes but
should be split into 4 separate PRs if obra wants to land them
incrementally.

## What if upstream goes silent?

If `obra/episodic-memory` stops receiving commits for >6 months and our
fork has accumulated material improvements, options:

1. **Stay a fork** — keep merging upstream changes when they come.
2. **Become a soft fork** — rename to `daniel-episodic-memory`, publish
   to npm, keep a permanent upstream-sync workflow but stop trying to
   contribute back.
3. **Take over as maintainer** — the most polite version of this is to
   open a "are you still maintaining?" issue and offer to maintain
   collaboratively before forking the project name.

Today we're at #1 and likely to stay there. Logging the options for
future-Daniel.

## What this fork should NOT do

- **Don't reorganize file layout.** It conflicts catastrophically on
  every merge.
- **Don't rename exports.** Same reason.
- **Don't bump dep majors without coordinating with upstream.** A
  TypeScript 5→6 bump in the fork while upstream is still on 5 means
  every merge is a fight.
- **Don't change `EMBEDDING_VERSION` independently.** That triggers
  full re-embeds for fork users; if upstream changes too, double-trigger.
- **Don't add lock-files when upstream doesn't.** `package-lock.json`
  is `.gitignore`'d for a reason — adding it creates noise.

## Where this gets revisited

- After every upstream release (`git log --oneline main..upstream/main | head` becomes non-empty)
- When opening a fork PR upstream
- Quarterly review during `next.md` → `now.md` promotion pass

## See also

- [`README.md`](README.md) · [`now.md`](now.md) · [`next.md`](next.md) · [`later.md`](later.md)
- [`/CLAUDE.md`](../../CLAUDE.md) § Upstream sync workflow (operational steps)
- [obra/episodic-memory#95](https://github.com/obra/episodic-memory/issues/95) — pending fork-patch PR
