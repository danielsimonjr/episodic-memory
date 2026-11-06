<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Complete File Inventory

This report lists each source file that the map census finds, with a disposition. The census reads the files that git tracks. Outside a git work tree, it walks the folder. The census skips tool state, dependency folders and build output (for example `.git/`, `node_modules/`, `dist/` and `target/`), and `obj/` and `bin/` for C#.

**Language**: typescript

**Total files**: 225

## Disposition counts

| Disposition | Count | Meaning |
| --- | --: | --- |
| `reachable` | 35 | A `src`-area file that an entry root reaches. |
| `build-entry` | 4 | A `src`-area file that is an entry root. |
| `test-only` | 38 | A `src`-area file that only a test reaches. |
| `orphan` | 14 | A `src`-area file that nothing reaches. Delete it, or wire it to a root. |
| `test` | 129 | A file in a `test/` or `tests/` folder, or a `*.test.ts` or `*.spec.ts` file. |
| `tool` | 4 | A file in a `tools/` or `scripts/` folder outside `src/`. |
| `config` | 1 | A `*.config.*` file of TypeScript or JavaScript. |
| `example` | 0 | A file in `examples/` or `docs/`. |
| `bench` | 0 | A file in `bench/` or `benchmarks/`, or a `*.bench.*` file. |
| **Total** | **225** | |

## Per-area counts

| Area | Files |
| --- | --: |
| `config` | 1 |
| `src` | 91 |
| `tests` | 129 |
| `tools` | 4 |

## Per-package counts

| Package | Files |
| --- | --: |
| `(root)` | 141 |
| `episodic-memory` | 84 |

## All files

| File | Package | Area | Disposition | Lines |
| --- | --- | --- | --- | --: |
| `cli/digest-hook.js` | (root) | src | orphan | 94 |
| `cli/ensure-deps.js` | (root) | src | orphan | 48 |
| `cli/episodic-memory.js` | (root) | src | orphan | 139 |
| `cli/index-conversations.js` | (root) | src | orphan | 150 |
| `cli/mcp-server-wrapper.js` | (root) | src | orphan | 106 |
| `cli/search-conversations.js` | (root) | src | orphan | 14 |
| `cli/sync-hook.js` | (root) | src | orphan | 199 |
| `scripts/claude-e2e.js` | (root) | tools | tool | 253 |
| `scripts/codex-e2e.js` | (root) | tools | tool | 367 |
| `scripts/generate-version.js` | (root) | tools | tool | 16 |
| `scripts/rebuild-native.mjs` | (root) | tools | tool | 120 |
| `src/api-endpoint.ts` | episodic-memory | src | reachable | 60 |
| `src/archive-path.ts` | episodic-memory | src | reachable | 205 |
| `src/backfill-cli.ts` | episodic-memory | src | orphan | 106 |
| `src/backfill.ts` | episodic-memory | src | test-only | 132 |
| `src/codex-hook-trust.ts` | episodic-memory | src | test-only | 134 |
| `src/codex-support.ts` | episodic-memory | src | reachable | 32 |
| `src/constants.ts` | episodic-memory | src | reachable | 49 |
| `src/db.ts` | episodic-memory | src | reachable | 461 |
| `src/deps-health.ts` | episodic-memory | src | test-only | 71 |
| `src/digest-compress.ts` | episodic-memory | src | test-only | 125 |
| `src/digest-db.ts` | episodic-memory | src | reachable | 207 |
| `src/digest-inject.ts` | episodic-memory | src | reachable | 56 |
| `src/digest-job.ts` | episodic-memory | src | test-only | 169 |
| `src/digest-phase.ts` | episodic-memory | src | test-only | 26 |
| `src/digest-prompts.ts` | episodic-memory | src | test-only | 74 |
| `src/digest-tool.ts` | episodic-memory | src | reachable | 59 |
| `src/digest-validate.ts` | episodic-memory | src | reachable | 60 |
| `src/doctor-cli.ts` | episodic-memory | src | orphan | 84 |
| `src/doctor-learn.ts` | episodic-memory | src | test-only | 330 |
| `src/doctor.ts` | episodic-memory | src | test-only | 412 |
| `src/embedding-migration.ts` | episodic-memory | src | reachable | 157 |
| `src/embeddings.ts` | episodic-memory | src | reachable | 149 |
| `src/gpu-reservation.ts` | episodic-memory | src | reachable | 81 |
| `src/index-cli.ts` | episodic-memory | src | build-entry | 204 |
| `src/index.ts` | episodic-memory | src | build-entry | 9 |
| `src/indexer.ts` | episodic-memory | src | reachable | 394 |
| `src/learn-cli.ts` | episodic-memory | src | orphan | 94 |
| `src/learn/agent-runner.ts` | episodic-memory | src | test-only | 433 |
| `src/learn/bootstrap.ts` | episodic-memory | src | test-only | 839 |
| `src/learn/cited-ids.ts` | episodic-memory | src | test-only | 243 |
| `src/learn/cli-main.ts` | episodic-memory | src | test-only | 823 |
| `src/learn/export.ts` | episodic-memory | src | test-only | 439 |
| `src/learn/grade.ts` | episodic-memory | src | test-only | 313 |
| `src/learn/knowledge-db.ts` | episodic-memory | src | test-only | 355 |
| `src/learn/knowledge-gate.ts` | episodic-memory | src | test-only | 178 |
| `src/learn/knowledge-store.ts` | episodic-memory | src | reachable | 1833 |
| `src/learn/leaf-learner.ts` | episodic-memory | src | test-only | 494 |
| `src/learn/learn-config.ts` | episodic-memory | src | reachable | 113 |
| `src/learn/learn-handlers.ts` | episodic-memory | src | test-only | 205 |
| `src/learn/learn-inject.ts` | episodic-memory | src | reachable | 282 |
| `src/learn/learn-lock.ts` | episodic-memory | src | test-only | 146 |
| `src/learn/learned-block.ts` | episodic-memory | src | test-only | 89 |
| `src/learn/learned-text-screen.ts` | episodic-memory | src | reachable | 197 |
| `src/learn/learner.ts` | episodic-memory | src | test-only | 1318 |
| `src/learn/learning-db.ts` | episodic-memory | src | test-only | 492 |
| `src/learn/learning-store.ts` | episodic-memory | src | test-only | 117 |
| `src/learn/pii-redactor.ts` | episodic-memory | src | reachable | 59 |
| `src/learn/prompts.ts` | episodic-memory | src | test-only | 479 |
| `src/learn/report.ts` | episodic-memory | src | test-only | 283 |
| `src/learn/sdk-tools.ts` | episodic-memory | src | test-only | 244 |
| `src/learn/semaphore.ts` | episodic-memory | src | test-only | 157 |
| `src/learn/skills-tool.ts` | episodic-memory | src | reachable | 160 |
| `src/learn/solver.ts` | episodic-memory | src | test-only | 296 |
| `src/learn/tasks.ts` | episodic-memory | src | test-only | 506 |
| `src/learn/types.ts` | episodic-memory | src | reachable | 185 |
| `src/learn/usage.ts` | episodic-memory | src | test-only | 60 |
| `src/learn/validate.ts` | episodic-memory | src | test-only | 354 |
| `src/lockfile.ts` | episodic-memory | src | reachable | 114 |
| `src/logging.ts` | episodic-memory | src | test-only | 63 |
| `src/mcp-auth.ts` | episodic-memory | src | reachable | 40 |
| `src/mcp-schemas.ts` | episodic-memory | src | reachable | 145 |
| `src/mcp-server.ts` | episodic-memory | src | build-entry | 140 |
| `src/mcp-tools.ts` | episodic-memory | src | reachable | 154 |
| `src/node-floor.ts` | episodic-memory | src | build-entry | 43 |
| `src/ollama-backend.ts` | episodic-memory | src | reachable | 110 |
| `src/orphan-reaper.ts` | episodic-memory | src | test-only | 54 |
| `src/parser.ts` | episodic-memory | src | reachable | 563 |
| `src/paths.ts` | episodic-memory | src | reachable | 200 |
| `src/priority.ts` | episodic-memory | src | test-only | 46 |
| `src/prune.ts` | episodic-memory | src | reachable | 104 |
| `src/redact.ts` | episodic-memory | src | reachable | 76 |
| `src/reentrancy.ts` | episodic-memory | src | reachable | 26 |
| `src/search-cli.ts` | episodic-memory | src | orphan | 122 |
| `src/search.ts` | episodic-memory | src | reachable | 518 |
| `src/show-cli.ts` | episodic-memory | src | orphan | 59 |
| `src/show.ts` | episodic-memory | src | reachable | 1025 |
| `src/stats-cli.ts` | episodic-memory | src | orphan | 32 |
| `src/stats.ts` | episodic-memory | src | test-only | 142 |
| `src/summarizer.ts` | episodic-memory | src | reachable | 714 |
| `src/sync-banner.ts` | episodic-memory | src | test-only | 29 |
| `src/sync-cli.ts` | episodic-memory | src | orphan | 238 |
| `src/sync.ts` | episodic-memory | src | test-only | 510 |
| `src/types.ts` | episodic-memory | src | reachable | 59 |
| `src/verify.ts` | episodic-memory | src | reachable | 200 |
| `test/agent-sdk-floor.test.ts` | (root) | tests | test | 39 |
| `test/allow-scripts-pin.test.ts` | (root) | tests | test | 79 |
| `test/archive-path-edges.test.ts` | (root) | tests | test | 67 |
| `test/archive-path.test.ts` | (root) | tests | test | 132 |
| `test/backfill-cli-gpu-reservation.test.ts` | (root) | tests | test | 51 |
| `test/backfill-gpu-reservation.test.ts` | (root) | tests | test | 125 |
| `test/backfill.test.ts` | (root) | tests | test | 122 |
| `test/claude-e2e-script.test.ts` | (root) | tests | test | 25 |
| `test/codex-doctor.test.ts` | (root) | tests | test | 154 |
| `test/codex-e2e-script.test.ts` | (root) | tests | test | 24 |
| `test/codex-hook-trust.test.ts` | (root) | tests | test | 34 |
| `test/codex-plugin.test.ts` | (root) | tests | test | 84 |
| `test/codex-skills.test.ts` | (root) | tests | test | 50 |
| `test/codex-support-extra.test.ts` | (root) | tests | test | 25 |
| `test/codex-support.test.ts` | (root) | tests | test | 31 |
| `test/codex-transcripts.test.ts` | (root) | tests | test | 288 |
| `test/constants.test.ts` | (root) | tests | test | 27 |
| `test/cosine-similarity.test.ts` | (root) | tests | test | 30 |
| `test/cross-harness-recall.test.ts` | (root) | tests | test | 86 |
| `test/db-helpers.test.ts` | (root) | tests | test | 102 |
| `test/db.test.ts` | (root) | tests | test | 123 |
| `test/deps-health.test.ts` | (root) | tests | test | 112 |
| `test/digest-compress.test.ts` | (root) | tests | test | 142 |
| `test/digest-db.test.ts` | (root) | tests | test | 139 |
| `test/digest-gpu-reservation.test.ts` | (root) | tests | test | 223 |
| `test/digest-hook.test.ts` | (root) | tests | test | 398 |
| `test/digest-inject.test.ts` | (root) | tests | test | 106 |
| `test/digest-job.test.ts` | (root) | tests | test | 133 |
| `test/digest-mcp.test.ts` | (root) | tests | test | 127 |
| `test/digest-prompts.test.ts` | (root) | tests | test | 69 |
| `test/digest-validate.test.ts` | (root) | tests | test | 62 |
| `test/doctor.test.ts` | (root) | tests | test | 358 |
| `test/embedding-migration-helpers.test.ts` | (root) | tests | test | 57 |
| `test/embedding-migration.test.ts` | (root) | tests | test | 221 |
| `test/embeddings-format.test.ts` | (root) | tests | test | 35 |
| `test/exclude-nested.test.ts` | (root) | tests | test | 124 |
| `test/gpu-reservation.test.ts` | (root) | tests | test | 149 |
| `test/helpers/forbid-modules.mjs` | (root) | tests | test | 40 |
| `test/hooks.test.ts` | (root) | tests | test | 41 |
| `test/incremental-indexing.test.ts` | (root) | tests | test | 108 |
| `test/integration.test.ts` | (root) | tests | test | 253 |
| `test/learn/agent-runner.test.ts` | (root) | tests | test | 366 |
| `test/learn/bootstrap.test.ts` | (root) | tests | test | 884 |
| `test/learn/cited-ids.test.ts` | (root) | tests | test | 211 |
| `test/learn/export.test.ts` | (root) | tests | test | 482 |
| `test/learn/grade.test.ts` | (root) | tests | test | 237 |
| `test/learn/knowledge-db.test.ts` | (root) | tests | test | 314 |
| `test/learn/knowledge-gate.test.ts` | (root) | tests | test | 370 |
| `test/learn/knowledge-store.test.ts` | (root) | tests | test | 604 |
| `test/learn/leaf-learner.test.ts` | (root) | tests | test | 589 |
| `test/learn/learn-cli.test.ts` | (root) | tests | test | 587 |
| `test/learn/learn-config.test.ts` | (root) | tests | test | 155 |
| `test/learn/learn-handlers.test.ts` | (root) | tests | test | 258 |
| `test/learn/learn-inject.test.ts` | (root) | tests | test | 310 |
| `test/learn/learn-lock.test.ts` | (root) | tests | test | 102 |
| `test/learn/learned-block.test.ts` | (root) | tests | test | 146 |
| `test/learn/learned-text-screen.test.ts` | (root) | tests | test | 368 |
| `test/learn/learner.test.ts` | (root) | tests | test | 669 |
| `test/learn/learning-db.test.ts` | (root) | tests | test | 290 |
| `test/learn/learning-store.test.ts` | (root) | tests | test | 271 |
| `test/learn/prompts.test.ts` | (root) | tests | test | 261 |
| `test/learn/relay-challenger.test.ts` | (root) | tests | test | 46 |
| `test/learn/relay-findings.test.ts` | (root) | tests | test | 98 |
| `test/learn/relay-task4-findings.test.ts` | (root) | tests | test | 168 |
| `test/learn/relay-task5-findings.test.ts` | (root) | tests | test | 91 |
| `test/learn/relay-task6-findings.test.ts` | (root) | tests | test | 141 |
| `test/learn/relay-task7-findings.test.ts` | (root) | tests | test | 34 |
| `test/learn/relay-task8-challenger.test.ts` | (root) | tests | test | 368 |
| `test/learn/relay-task9-findings.test.ts` | (root) | tests | test | 385 |
| `test/learn/report.test.ts` | (root) | tests | test | 295 |
| `test/learn/sdk-tools.test.ts` | (root) | tests | test | 182 |
| `test/learn/semaphore.test.ts` | (root) | tests | test | 115 |
| `test/learn/skills-tool.test.ts` | (root) | tests | test | 233 |
| `test/learn/solver.test.ts` | (root) | tests | test | 489 |
| `test/learn/tasks.test.ts` | (root) | tests | test | 469 |
| `test/learn/validate.test.ts` | (root) | tests | test | 444 |
| `test/lockfile.test.ts` | (root) | tests | test | 68 |
| `test/logging-append.test.ts` | (root) | tests | test | 27 |
| `test/logging.test.ts` | (root) | tests | test | 73 |
| `test/mcp-auth.test.ts` | (root) | tests | test | 34 |
| `test/mcp-protocol.test.ts` | (root) | tests | test | 282 |
| `test/mcp-read-redaction.test.ts` | (root) | tests | test | 48 |
| `test/mcp-schemas.test.ts` | (root) | tests | test | 66 |
| `test/mcp-tools.test.ts` | (root) | tests | test | 154 |
| `test/multi-concept.test.ts` | (root) | tests | test | 68 |
| `test/node-floor.test.ts` | (root) | tests | test | 43 |
| `test/ollama-backend.test.ts` | (root) | tests | test | 75 |
| `test/orphan-reaper.test.ts` | (root) | tests | test | 65 |
| `test/oversized-message-guard.test.ts` | (root) | tests | test | 136 |
| `test/parser-tool-result.test.ts` | (root) | tests | test | 43 |
| `test/parser.test.ts` | (root) | tests | test | 141 |
| `test/paths.test.ts` | (root) | tests | test | 120 |
| `test/priority.test.ts` | (root) | tests | test | 48 |
| `test/prune.test.ts` | (root) | tests | test | 163 |
| `test/query-prefix.test.ts` | (root) | tests | test | 19 |
| `test/rebuild-native.test.ts` | (root) | tests | test | 48 |
| `test/redact-patterns.test.ts` | (root) | tests | test | 34 |
| `test/reentrancy.test.ts` | (root) | tests | test | 42 |
| `test/search-agent-template.test.ts` | (root) | tests | test | 162 |
| `test/search-metadata-filters.test.ts` | (root) | tests | test | 274 |
| `test/search-with-summary.test.ts` | (root) | tests | test | 107 |
| `test/security-speed-helpers.test.ts` | (root) | tests | test | 69 |
| `test/show.test.ts` | (root) | tests | test | 353 |
| `test/stats-format.test.ts` | (root) | tests | test | 29 |
| `test/stats.test.ts` | (root) | tests | test | 135 |
| `test/summarizer-api-env.test.ts` | (root) | tests | test | 44 |
| `test/summarizer-claude-path.test.ts` | (root) | tests | test | 158 |
| `test/summarizer-gpu-reservation.test.ts` | (root) | tests | test | 119 |
| `test/summarizer-options.test.ts` | (root) | tests | test | 295 |
| `test/summarizer-text.test.ts` | (root) | tests | test | 44 |
| `test/sync-banner.test.ts` | (root) | tests | test | 34 |
| `test/sync-cli-lock.test.ts` | (root) | tests | test | 46 |
| `test/sync-cli-reentrancy.test.ts` | (root) | tests | test | 35 |
| `test/sync-empty-summary-audit.test.ts` | (root) | tests | test | 103 |
| `test/sync-gpu-reservation.test.ts` | (root) | tests | test | 142 |
| `test/sync-helpers.test.ts` | (root) | tests | test | 40 |
| `test/sync-hook-gpu-reservation.test.ts` | (root) | tests | test | 90 |
| `test/sync-hook-learn-pids.test.ts` | (root) | tests | test | 136 |
| `test/sync-hook-logging.test.ts` | (root) | tests | test | 27 |
| `test/sync-incremental-and-db.test.ts` | (root) | tests | test | 187 |
| `test/sync-pending-and-legacy-retry.test.ts` | (root) | tests | test | 177 |
| `test/sync-session-id.test.ts` | (root) | tests | test | 14 |
| `test/sync-summary-retry.test.ts` | (root) | tests | test | 110 |
| `test/sync.test.ts` | (root) | tests | test | 250 |
| `test/test-indexer.ts` | (root) | tests | test | 44 |
| `test/test-utils.ts` | (root) | tests | test | 100 |
| `test/tool-calls-cascade.test.ts` | (root) | tests | test | 125 |
| `test/verify.test.ts` | (root) | tests | test | 320 |
| `test/version-consistency.test.ts` | (root) | tests | test | 30 |
| `vitest.config.ts` | (root) | config | config | 25 |

## Skipped links

Links (symbolic links and junctions) that the census did not follow. A link can point to another repository, so no file behind a link is in this inventory or in the graph.

_None._

## Warnings

- package.json entry './cli/search-conversations' did not resolve to a known source file. The entry is ignored.
- package.json entry './cli/mcp-server' did not resolve to a known source file. The entry is ignored.
