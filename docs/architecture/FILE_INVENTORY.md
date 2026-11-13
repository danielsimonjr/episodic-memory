<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Complete File Inventory

This report lists each source file that the map census finds, with a disposition. The census reads the files that git tracks. Outside a git work tree, it walks the folder. The census skips tool state, dependency folders and build output (for example `.git/`, `node_modules/`, `dist/` and `target/`), and `obj/` and `bin/` for C#.

**Language**: typescript

**Total files**: 274

## Disposition counts

| Disposition | Count | Meaning |
| --- | --: | --- |
| `reachable` | 43 | A `src`-area file that an entry root reaches. |
| `build-entry` | 4 | A `src`-area file that is an entry root. |
| `test-only` | 46 | A `src`-area file that only a test reaches. |
| `orphan` | 15 | A `src`-area file that nothing reaches. Delete it, or wire it to a root. |
| `test` | 161 | A file in a `test/` or `tests/` folder, or a `*.test.ts` or `*.spec.ts` file. |
| `tool` | 4 | A file in a `tools/` or `scripts/` folder outside `src/`. |
| `config` | 1 | A `*.config.*` file of TypeScript or JavaScript. |
| `example` | 0 | A file in `examples/` or `docs/`. |
| `bench` | 0 | A file in `bench/` or `benchmarks/`, or a `*.bench.*` file. |
| **Total** | **274** | |

## Per-area counts

| Area | Files |
| --- | --: |
| `config` | 1 |
| `src` | 108 |
| `tests` | 161 |
| `tools` | 4 |

## Per-package counts

| Package | Files |
| --- | --: |
| `(root)` | 175 |
| `episodic-memory` | 99 |

## All files

| File | Package | Area | Disposition | Lines |
| --- | --- | --- | --- | --: |
| `cli/digest-hook.js` | (root) | src | orphan | 96 |
| `cli/ensure-deps.js` | (root) | src | test-only | 389 |
| `cli/episodic-memory.js` | (root) | src | orphan | 120 |
| `cli/forward-child.js` | (root) | src | orphan | 57 |
| `cli/index-conversations.js` | (root) | src | orphan | 147 |
| `cli/mcp-server-wrapper.js` | (root) | src | orphan | 106 |
| `cli/search-conversations.js` | (root) | src | orphan | 8 |
| `cli/sync-hook.js` | (root) | src | orphan | 196 |
| `scripts/claude-e2e.js` | (root) | tools | tool | 253 |
| `scripts/codex-e2e.js` | (root) | tools | tool | 367 |
| `scripts/generate-version.js` | (root) | tools | tool | 16 |
| `scripts/rebuild-native.mjs` | (root) | tools | tool | 120 |
| `src/api-endpoint.ts` | episodic-memory | src | reachable | 60 |
| `src/archive-path.ts` | episodic-memory | src | reachable | 212 |
| `src/backfill-cli.ts` | episodic-memory | src | orphan | 107 |
| `src/backfill.ts` | episodic-memory | src | test-only | 164 |
| `src/claude-bin.ts` | episodic-memory | src | reachable | 233 |
| `src/codex-hook-trust.ts` | episodic-memory | src | test-only | 157 |
| `src/codex-support.ts` | episodic-memory | src | reachable | 66 |
| `src/constants.ts` | episodic-memory | src | reachable | 93 |
| `src/content-text.ts` | episodic-memory | src | reachable | 33 |
| `src/db.ts` | episodic-memory | src | reachable | 546 |
| `src/deferral.ts` | episodic-memory | src | reachable | 21 |
| `src/deps-health.ts` | episodic-memory | src | test-only | 149 |
| `src/digest-compress.ts` | episodic-memory | src | test-only | 137 |
| `src/digest-db.ts` | episodic-memory | src | reachable | 259 |
| `src/digest-inject.ts` | episodic-memory | src | reachable | 62 |
| `src/digest-job.ts` | episodic-memory | src | test-only | 209 |
| `src/digest-phase.ts` | episodic-memory | src | test-only | 28 |
| `src/digest-prompts.ts` | episodic-memory | src | test-only | 122 |
| `src/digest-tool.ts` | episodic-memory | src | reachable | 59 |
| `src/digest-validate.ts` | episodic-memory | src | reachable | 107 |
| `src/doctor-cli.ts` | episodic-memory | src | orphan | 84 |
| `src/doctor-learn.ts` | episodic-memory | src | test-only | 346 |
| `src/doctor.ts` | episodic-memory | src | test-only | 455 |
| `src/embedding-migration.ts` | episodic-memory | src | reachable | 197 |
| `src/embeddings.ts` | episodic-memory | src | reachable | 168 |
| `src/fs-retry.ts` | episodic-memory | src | test-only | 45 |
| `src/fts-query.ts` | episodic-memory | src | reachable | 14 |
| `src/gpu-reservation.ts` | episodic-memory | src | reachable | 98 |
| `src/index-cli.ts` | episodic-memory | src | build-entry | 280 |
| `src/index.ts` | episodic-memory | src | build-entry | 9 |
| `src/indexer.ts` | episodic-memory | src | reachable | 417 |
| `src/learn-cli.ts` | episodic-memory | src | orphan | 94 |
| `src/learn/agent-runner.ts` | episodic-memory | src | test-only | 568 |
| `src/learn/bootstrap.ts` | episodic-memory | src | test-only | 850 |
| `src/learn/cited-ids.ts` | episodic-memory | src | test-only | 267 |
| `src/learn/cli-main.ts` | episodic-memory | src | test-only | 884 |
| `src/learn/entry-order.ts` | episodic-memory | src | test-only | 57 |
| `src/learn/export.ts` | episodic-memory | src | test-only | 406 |
| `src/learn/grade.ts` | episodic-memory | src | test-only | 318 |
| `src/learn/knowledge-db.ts` | episodic-memory | src | test-only | 341 |
| `src/learn/knowledge-gate.ts` | episodic-memory | src | test-only | 191 |
| `src/learn/knowledge-store.ts` | episodic-memory | src | reachable | 1893 |
| `src/learn/leaf-learner.ts` | episodic-memory | src | test-only | 496 |
| `src/learn/learn-config.ts` | episodic-memory | src | reachable | 134 |
| `src/learn/learn-handlers.ts` | episodic-memory | src | test-only | 225 |
| `src/learn/learn-inject.ts` | episodic-memory | src | reachable | 291 |
| `src/learn/learn-lock.ts` | episodic-memory | src | test-only | 173 |
| `src/learn/learned-block.ts` | episodic-memory | src | test-only | 78 |
| `src/learn/learned-text-screen.ts` | episodic-memory | src | reachable | 206 |
| `src/learn/learner.ts` | episodic-memory | src | test-only | 1328 |
| `src/learn/learning-db.ts` | episodic-memory | src | test-only | 536 |
| `src/learn/learning-store.ts` | episodic-memory | src | test-only | 123 |
| `src/learn/pii-redactor.ts` | episodic-memory | src | reachable | 60 |
| `src/learn/prng.ts` | episodic-memory | src | test-only | 25 |
| `src/learn/prompts.ts` | episodic-memory | src | test-only | 504 |
| `src/learn/report.ts` | episodic-memory | src | test-only | 288 |
| `src/learn/sdk-tools.ts` | episodic-memory | src | test-only | 248 |
| `src/learn/semaphore.ts` | episodic-memory | src | test-only | 163 |
| `src/learn/skills-tool.ts` | episodic-memory | src | reachable | 168 |
| `src/learn/solver.ts` | episodic-memory | src | test-only | 300 |
| `src/learn/tasks.ts` | episodic-memory | src | test-only | 522 |
| `src/learn/types.ts` | episodic-memory | src | reachable | 227 |
| `src/learn/usage.ts` | episodic-memory | src | test-only | 60 |
| `src/learn/validate.ts` | episodic-memory | src | test-only | 348 |
| `src/lockfile.ts` | episodic-memory | src | reachable | 149 |
| `src/logging.ts` | episodic-memory | src | test-only | 86 |
| `src/mcp-auth.ts` | episodic-memory | src | reachable | 68 |
| `src/mcp-schemas.ts` | episodic-memory | src | reachable | 274 |
| `src/mcp-server.ts` | episodic-memory | src | build-entry | 163 |
| `src/mcp-tools.ts` | episodic-memory | src | reachable | 174 |
| `src/node-floor.ts` | episodic-memory | src | build-entry | 43 |
| `src/ollama-backend.ts` | episodic-memory | src | reachable | 145 |
| `src/orphan-reaper.ts` | episodic-memory | src | test-only | 56 |
| `src/parser.ts` | episodic-memory | src | reachable | 553 |
| `src/paths.ts` | episodic-memory | src | reachable | 199 |
| `src/priority.ts` | episodic-memory | src | test-only | 46 |
| `src/prune.ts` | episodic-memory | src | reachable | 110 |
| `src/redact.ts` | episodic-memory | src | reachable | 84 |
| `src/reentrancy.ts` | episodic-memory | src | reachable | 25 |
| `src/search-cli.ts` | episodic-memory | src | orphan | 122 |
| `src/search.ts` | episodic-memory | src | reachable | 565 |
| `src/show-cli.ts` | episodic-memory | src | orphan | 59 |
| `src/show.ts` | episodic-memory | src | reachable | 1027 |
| `src/stats-cli.ts` | episodic-memory | src | orphan | 32 |
| `src/stats.ts` | episodic-memory | src | test-only | 172 |
| `src/summarizer.ts` | episodic-memory | src | reachable | 822 |
| `src/sync-banner.ts` | episodic-memory | src | test-only | 33 |
| `src/sync-cli.ts` | episodic-memory | src | orphan | 248 |
| `src/sync.ts` | episodic-memory | src | test-only | 536 |
| `src/topic-db.ts` | episodic-memory | src | reachable | 521 |
| `src/topic-format.ts` | episodic-memory | src | reachable | 462 |
| `src/topic-job.ts` | episodic-memory | src | test-only | 309 |
| `src/topic-phase.ts` | episodic-memory | src | test-only | 40 |
| `src/topic-prompts.ts` | episodic-memory | src | test-only | 291 |
| `src/topic-time.ts` | episodic-memory | src | reachable | 42 |
| `src/topic-tool.ts` | episodic-memory | src | reachable | 149 |
| `src/topic-validate.ts` | episodic-memory | src | test-only | 218 |
| `src/types.ts` | episodic-memory | src | reachable | 82 |
| `src/verify.ts` | episodic-memory | src | reachable | 226 |
| `test/agent-sdk-floor.test.ts` | (root) | tests | test | 39 |
| `test/allow-scripts-pin.test.ts` | (root) | tests | test | 88 |
| `test/archive-path-edges.test.ts` | (root) | tests | test | 67 |
| `test/archive-path.test.ts` | (root) | tests | test | 132 |
| `test/backfill-cli-gpu-reservation.test.ts` | (root) | tests | test | 51 |
| `test/backfill-gpu-reservation.test.ts` | (root) | tests | test | 125 |
| `test/backfill.test.ts` | (root) | tests | test | 122 |
| `test/claude-bin-deferral.test.ts` | (root) | tests | test | 180 |
| `test/claude-bin.test.ts` | (root) | tests | test | 230 |
| `test/claude-e2e-script.test.ts` | (root) | tests | test | 25 |
| `test/cli-forward.test.ts` | (root) | tests | test | 174 |
| `test/codex-doctor.test.ts` | (root) | tests | test | 154 |
| `test/codex-e2e-script.test.ts` | (root) | tests | test | 24 |
| `test/codex-hook-trust.test.ts` | (root) | tests | test | 34 |
| `test/codex-plugin.test.ts` | (root) | tests | test | 85 |
| `test/codex-skills.test.ts` | (root) | tests | test | 50 |
| `test/codex-support-extra.test.ts` | (root) | tests | test | 25 |
| `test/codex-support.test.ts` | (root) | tests | test | 31 |
| `test/codex-transcripts.test.ts` | (root) | tests | test | 288 |
| `test/constants.test.ts` | (root) | tests | test | 27 |
| `test/content-text.test.ts` | (root) | tests | test | 47 |
| `test/cosine-similarity.test.ts` | (root) | tests | test | 30 |
| `test/cross-harness-recall.test.ts` | (root) | tests | test | 86 |
| `test/db-helpers.test.ts` | (root) | tests | test | 102 |
| `test/db.test.ts` | (root) | tests | test | 123 |
| `test/deps-health.test.ts` | (root) | tests | test | 207 |
| `test/digest-compress.test.ts` | (root) | tests | test | 142 |
| `test/digest-db.test.ts` | (root) | tests | test | 153 |
| `test/digest-gpu-reservation.test.ts` | (root) | tests | test | 247 |
| `test/digest-hook.test.ts` | (root) | tests | test | 417 |
| `test/digest-inject.test.ts` | (root) | tests | test | 106 |
| `test/digest-job.test.ts` | (root) | tests | test | 133 |
| `test/digest-mcp.test.ts` | (root) | tests | test | 127 |
| `test/digest-prompt-budget.test.ts` | (root) | tests | test | 105 |
| `test/digest-prompts.test.ts` | (root) | tests | test | 77 |
| `test/digest-validate.test.ts` | (root) | tests | test | 93 |
| `test/doctor.test.ts` | (root) | tests | test | 360 |
| `test/embedding-migration-helpers.test.ts` | (root) | tests | test | 57 |
| `test/embedding-migration.test.ts` | (root) | tests | test | 221 |
| `test/embeddings-format.test.ts` | (root) | tests | test | 35 |
| `test/ensure-deps-prune.test.ts` | (root) | tests | test | 275 |
| `test/ensure-deps-repair.test.ts` | (root) | tests | test | 364 |
| `test/exclude-nested.test.ts` | (root) | tests | test | 124 |
| `test/global-setup.test.ts` | (root) | tests | test | 22 |
| `test/global-setup.ts` | (root) | tests | test | 14 |
| `test/gpu-reservation.test.ts` | (root) | tests | test | 155 |
| `test/helpers/forbid-modules.mjs` | (root) | tests | test | 40 |
| `test/hooks.test.ts` | (root) | tests | test | 41 |
| `test/incremental-indexing.test.ts` | (root) | tests | test | 108 |
| `test/index-cli-args.test.ts` | (root) | tests | test | 221 |
| `test/integration.test.ts` | (root) | tests | test | 253 |
| `test/learn/agent-runner.test.ts` | (root) | tests | test | 521 |
| `test/learn/bootstrap.test.ts` | (root) | tests | test | 908 |
| `test/learn/cited-ids.test.ts` | (root) | tests | test | 211 |
| `test/learn/entry-order.test.ts` | (root) | tests | test | 62 |
| `test/learn/export.test.ts` | (root) | tests | test | 557 |
| `test/learn/grade.test.ts` | (root) | tests | test | 237 |
| `test/learn/knowledge-db.test.ts` | (root) | tests | test | 314 |
| `test/learn/knowledge-gate.test.ts` | (root) | tests | test | 370 |
| `test/learn/knowledge-store-write-lock.test.ts` | (root) | tests | test | 88 |
| `test/learn/knowledge-store.test.ts` | (root) | tests | test | 604 |
| `test/learn/leaf-learner.test.ts` | (root) | tests | test | 590 |
| `test/learn/learn-cli.test.ts` | (root) | tests | test | 666 |
| `test/learn/learn-config.test.ts` | (root) | tests | test | 157 |
| `test/learn/learn-handlers.test.ts` | (root) | tests | test | 258 |
| `test/learn/learn-inject.test.ts` | (root) | tests | test | 310 |
| `test/learn/learn-lock.test.ts` | (root) | tests | test | 147 |
| `test/learn/learned-block.test.ts` | (root) | tests | test | 146 |
| `test/learn/learned-text-screen.test.ts` | (root) | tests | test | 368 |
| `test/learn/learner.test.ts` | (root) | tests | test | 718 |
| `test/learn/learning-db.test.ts` | (root) | tests | test | 290 |
| `test/learn/learning-store.test.ts` | (root) | tests | test | 271 |
| `test/learn/prng.test.ts` | (root) | tests | test | 42 |
| `test/learn/prompts.test.ts` | (root) | tests | test | 261 |
| `test/learn/relay-challenger.test.ts` | (root) | tests | test | 46 |
| `test/learn/relay-findings.test.ts` | (root) | tests | test | 98 |
| `test/learn/relay-task4-findings.test.ts` | (root) | tests | test | 168 |
| `test/learn/relay-task5-findings.test.ts` | (root) | tests | test | 91 |
| `test/learn/relay-task6-findings.test.ts` | (root) | tests | test | 144 |
| `test/learn/relay-task7-findings.test.ts` | (root) | tests | test | 34 |
| `test/learn/relay-task8-challenger.test.ts` | (root) | tests | test | 368 |
| `test/learn/relay-task9-findings.test.ts` | (root) | tests | test | 385 |
| `test/learn/report.test.ts` | (root) | tests | test | 295 |
| `test/learn/sdk-tools.test.ts` | (root) | tests | test | 182 |
| `test/learn/semaphore.test.ts` | (root) | tests | test | 115 |
| `test/learn/skills-tool.test.ts` | (root) | tests | test | 233 |
| `test/learn/solver.test.ts` | (root) | tests | test | 489 |
| `test/learn/tasks.test.ts` | (root) | tests | test | 469 |
| `test/learn/validate.test.ts` | (root) | tests | test | 473 |
| `test/lockfile.test.ts` | (root) | tests | test | 85 |
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
| `test/ollama-plain-reply.test.ts` | (root) | tests | test | 55 |
| `test/onnxruntime-web-stub.test.ts` | (root) | tests | test | 76 |
| `test/orphan-reaper.test.ts` | (root) | tests | test | 65 |
| `test/oversized-message-guard.test.ts` | (root) | tests | test | 136 |
| `test/parser-tool-result.test.ts` | (root) | tests | test | 43 |
| `test/parser.test.ts` | (root) | tests | test | 141 |
| `test/paths.test.ts` | (root) | tests | test | 120 |
| `test/priority.test.ts` | (root) | tests | test | 48 |
| `test/prune.test.ts` | (root) | tests | test | 174 |
| `test/query-prefix.test.ts` | (root) | tests | test | 19 |
| `test/real-sdk-guard.test.ts` | (root) | tests | test | 45 |
| `test/real-sdk-guard.ts` | (root) | tests | test | 33 |
| `test/rebuild-native.test.ts` | (root) | tests | test | 48 |
| `test/redact-patterns.test.ts` | (root) | tests | test | 44 |
| `test/reentrancy.test.ts` | (root) | tests | test | 42 |
| `test/runtime-imports.test.ts` | (root) | tests | test | 91 |
| `test/search-agent-template.test.ts` | (root) | tests | test | 162 |
| `test/search-metadata-filters.test.ts` | (root) | tests | test | 273 |
| `test/search-with-summary.test.ts` | (root) | tests | test | 107 |
| `test/security-speed-helpers.test.ts` | (root) | tests | test | 69 |
| `test/setup-env.ts` | (root) | tests | test | 27 |
| `test/show.test.ts` | (root) | tests | test | 353 |
| `test/stats-format.test.ts` | (root) | tests | test | 29 |
| `test/stats.test.ts` | (root) | tests | test | 135 |
| `test/summarizer-api-env.test.ts` | (root) | tests | test | 44 |
| `test/summarizer-claude-path.test.ts` | (root) | tests | test | 158 |
| `test/summarizer-gpu-reservation.test.ts` | (root) | tests | test | 119 |
| `test/summarizer-ollama-fallback.test.ts` | (root) | tests | test | 83 |
| `test/summarizer-options.test.ts` | (root) | tests | test | 303 |
| `test/summarizer-prompt-budget.test.ts` | (root) | tests | test | 72 |
| `test/summarizer-text.test.ts` | (root) | tests | test | 44 |
| `test/sync-banner.test.ts` | (root) | tests | test | 34 |
| `test/sync-cli-args.test.ts` | (root) | tests | test | 49 |
| `test/sync-cli-lock.test.ts` | (root) | tests | test | 46 |
| `test/sync-cli-reentrancy.test.ts` | (root) | tests | test | 35 |
| `test/sync-copy-retry.test.ts` | (root) | tests | test | 110 |
| `test/sync-empty-summary-audit.test.ts` | (root) | tests | test | 103 |
| `test/sync-gpu-reservation.test.ts` | (root) | tests | test | 142 |
| `test/sync-helpers.test.ts` | (root) | tests | test | 40 |
| `test/sync-hook-gpu-reservation.test.ts` | (root) | tests | test | 90 |
| `test/sync-hook-learn-pids.test.ts` | (root) | tests | test | 151 |
| `test/sync-hook-logging.test.ts` | (root) | tests | test | 27 |
| `test/sync-incremental-and-db.test.ts` | (root) | tests | test | 187 |
| `test/sync-pending-and-legacy-retry.test.ts` | (root) | tests | test | 177 |
| `test/sync-session-id.test.ts` | (root) | tests | test | 14 |
| `test/sync-summary-retry.test.ts` | (root) | tests | test | 110 |
| `test/sync.test.ts` | (root) | tests | test | 250 |
| `test/test-env.test.ts` | (root) | tests | test | 23 |
| `test/test-env.ts` | (root) | tests | test | 23 |
| `test/test-indexer.ts` | (root) | tests | test | 45 |
| `test/test-utils.ts` | (root) | tests | test | 100 |
| `test/tool-calls-cascade.test.ts` | (root) | tests | test | 125 |
| `test/topic-db.test.ts` | (root) | tests | test | 338 |
| `test/topic-format.test.ts` | (root) | tests | test | 379 |
| `test/topic-job.test.ts` | (root) | tests | test | 570 |
| `test/topic-phase.test.ts` | (root) | tests | test | 102 |
| `test/topic-prompts.test.ts` | (root) | tests | test | 663 |
| `test/topic-tool.test.ts` | (root) | tests | test | 492 |
| `test/topic-validate.test.ts` | (root) | tests | test | 371 |
| `test/verify.test.ts` | (root) | tests | test | 328 |
| `test/version-consistency.test.ts` | (root) | tests | test | 30 |
| `vendor/onnxruntime-web-stub/index.js` | (root) | src | orphan | 3 |
| `vitest.config.ts` | (root) | config | config | 26 |

## Skipped links

Links (symbolic links and junctions) that the census did not follow. A link can point to another repository, so no file behind a link is in this inventory or in the graph.

_None._

## Warnings

- package.json entry './cli/search-conversations' did not resolve to a known source file. The entry is ignored.
- package.json entry './cli/mcp-server' did not resolve to a known source file. The entry is ignored.
