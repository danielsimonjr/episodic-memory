<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Test Coverage Analysis

## Summary

| Metric | Count |
|--------|-------|
| Total Source Files | 100 |
| Total Test Files | 142 |
| Source Files with Tests | 79 |
| Source Files without Tests | 21 |
| Coverage (raw, direct-import) | **79.0%** |
---

## Source Files Not Imported By A Test

The following 21 source files are not directly imported by any test file:

### root/

- `cli/digest-hook.js`
- `cli/episodic-memory.js`
- `cli/index-conversations.js`
- `cli/mcp-server-wrapper.js`
- `cli/search-conversations.js`
- `cli/sync-hook.js`
- `src/backfill-cli.ts`
- `src/doctor-cli.ts`
- `src/fts-query.ts`
- `src/index-cli.ts`
- `src/index.ts`
- `src/learn-cli.ts`
- `src/mcp-server.ts`
- `src/search-cli.ts`
- `src/show-cli.ts`
- `src/stats-cli.ts`
- `src/sync-cli.ts`
- `src/topic-time.ts`
- `src/topic-tool.ts`

### learn/

- `src/learn/pii-redactor.ts`
- `src/learn/usage.ts`

---

## Source Files Imported By A Test

| Source File | Test Files |
|-------------|------------|
| `cli/ensure-deps.js` | `runtime-imports.test.ts` |
| `src/api-endpoint.ts` | `security-speed-helpers.test.ts` |
| `src/archive-path.ts` | `archive-path-edges.test.ts`, `archive-path.test.ts` |
| `src/backfill.ts` | `backfill-gpu-reservation.test.ts`, `backfill.test.ts` |
| `src/codex-hook-trust.ts` | `codex-doctor.test.ts`, `codex-hook-trust.test.ts` |
| `src/codex-support.ts` | `codex-support-extra.test.ts`, `codex-support.test.ts` |
| `src/constants.ts` | `constants.test.ts`, `digest-prompts.test.ts`, `embeddings-format.test.ts`, `oversized-message-guard.test.ts`, `sync-helpers.test.ts`, `topic-prompts.test.ts` |
| `src/db.ts` | `codex-transcripts.test.ts`, `cross-harness-recall.test.ts`, `db-helpers.test.ts`, `db.test.ts`, `digest-db.test.ts`, `digest-gpu-reservation.test.ts`, `digest-hook.test.ts`, `digest-job.test.ts`, `digest-mcp.test.ts`, `digest-prompt-budget.test.ts`, `doctor.test.ts`, `embedding-migration-helpers.test.ts`, `integration.test.ts`, `learn-handlers.test.ts`, `mcp-tools.test.ts`, `oversized-message-guard.test.ts`, `prune.test.ts`, `sync-incremental-and-db.test.ts`, `tool-calls-cascade.test.ts`, `topic-job.test.ts`, `topic-phase.test.ts`, `topic-tool.test.ts`, `verify.test.ts` |
| `src/deps-health.ts` | `deps-health.test.ts` |
| `src/digest-compress.ts` | `digest-compress.test.ts`, `digest-gpu-reservation.test.ts` |
| `src/digest-db.ts` | `digest-compress.test.ts`, `digest-db.test.ts`, `digest-gpu-reservation.test.ts`, `digest-hook.test.ts`, `digest-inject.test.ts`, `digest-job.test.ts`, `digest-mcp.test.ts`, `digest-prompts.test.ts`, `learn-handlers.test.ts` |
| `src/digest-inject.ts` | `digest-hook.test.ts`, `digest-inject.test.ts`, `learn-handlers.test.ts`, `skills-tool.test.ts`, `topic-tool.test.ts` |
| `src/digest-job.ts` | `digest-gpu-reservation.test.ts`, `digest-job.test.ts`, `digest-prompt-budget.test.ts` |
| `src/digest-phase.ts` | `digest-mcp.test.ts` |
| `src/digest-prompts.ts` | `digest-prompt-budget.test.ts`, `digest-prompts.test.ts`, `topic-prompts.test.ts` |
| `src/digest-tool.ts` | `digest-mcp.test.ts` |
| `src/digest-validate.ts` | `digest-validate.test.ts` |
| `src/doctor-learn.ts` | `doctor.test.ts` |
| `src/doctor.ts` | `codex-doctor.test.ts`, `doctor.test.ts` |
| `src/embedding-migration.ts` | `embedding-migration-helpers.test.ts`, `embedding-migration.test.ts` |
| `src/embeddings.ts` | `embedding-migration.test.ts`, `embeddings-format.test.ts`, `integration.test.ts`, `multi-concept.test.ts`, `query-prefix.test.ts`, `verify.test.ts` |
| `src/gpu-reservation.ts` | `gpu-reservation.test.ts` |
| `src/indexer.ts` | `exclude-nested.test.ts`, `incremental-indexing.test.ts`, `learn-handlers.test.ts`, `search-metadata-filters.test.ts` |
| `learn/agent-runner.ts` | `agent-runner.test.ts` |
| `learn/bootstrap.ts` | `bootstrap.test.ts`, `relay-task7-findings.test.ts` |
| `learn/cited-ids.ts` | `cited-ids.test.ts`, `relay-challenger.test.ts` |
| `learn/cli-main.ts` | `export.test.ts`, `learn-cli.test.ts`, `relay-task6-findings.test.ts` |
| `learn/export.ts` | `export.test.ts` |
| `learn/grade.ts` | `grade.test.ts`, `relay-task4-findings.test.ts` |
| `learn/knowledge-db.ts` | `doctor.test.ts`, `export.test.ts`, `knowledge-db.test.ts`, `knowledge-store.test.ts`, `leaf-learner.test.ts`, `learn-cli.test.ts`, `learned-block.test.ts`, `learner.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `report.test.ts`, `skills-tool.test.ts`, `solver.test.ts`, `validate.test.ts` |
| `learn/knowledge-gate.ts` | `knowledge-gate.test.ts`, `relay-challenger.test.ts` |
| `learn/knowledge-store.ts` | `doctor.test.ts`, `bootstrap.test.ts`, `export.test.ts`, `knowledge-db.test.ts`, `knowledge-store-write-lock.test.ts`, `knowledge-store.test.ts`, `leaf-learner.test.ts`, `learn-cli.test.ts`, `learned-block.test.ts`, `learner.test.ts`, `learning-store.test.ts`, `relay-task6-findings.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `report.test.ts`, `skills-tool.test.ts`, `solver.test.ts`, `validate.test.ts` |
| `learn/leaf-learner.ts` | `leaf-learner.test.ts`, `relay-task8-challenger.test.ts` |
| `learn/learn-config.ts` | `knowledge-gate.test.ts`, `learn-config.test.ts`, `learn-handlers.test.ts` |
| `learn/learn-handlers.ts` | `learn-handlers.test.ts` |
| `learn/learn-inject.ts` | `digest-hook.test.ts`, `learn-inject.test.ts`, `relay-findings.test.ts` |
| `learn/learn-lock.ts` | `learn-cli.test.ts`, `learn-lock.test.ts` |
| `learn/learned-block.ts` | `learned-block.test.ts`, `relay-findings.test.ts` |
| `learn/learned-text-screen.ts` | `learn-inject.test.ts`, `learned-text-screen.test.ts` |
| `learn/learner.ts` | `learner.test.ts`, `relay-task9-findings.test.ts` |
| `learn/learning-db.ts` | `doctor.test.ts`, `bootstrap.test.ts`, `leaf-learner.test.ts`, `learn-cli.test.ts`, `learner.test.ts`, `learning-db.test.ts`, `relay-task4-findings.test.ts`, `relay-task6-findings.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `report.test.ts`, `solver.test.ts`, `tasks.test.ts`, `validate.test.ts` |
| `learn/learning-store.ts` | `digest-hook.test.ts`, `doctor.test.ts`, `bootstrap.test.ts`, `export.test.ts`, `knowledge-db.test.ts`, `leaf-learner.test.ts`, `learn-cli.test.ts`, `learn-inject.test.ts`, `learned-block.test.ts`, `learner.test.ts`, `learning-db.test.ts`, `learning-store.test.ts`, `relay-task4-findings.test.ts`, `relay-task6-findings.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `report.test.ts`, `solver.test.ts`, `tasks.test.ts`, `validate.test.ts` |
| `learn/prompts.ts` | `prompts.test.ts` |
| `learn/report.ts` | `report.test.ts` |
| `learn/sdk-tools.ts` | `agent-runner.test.ts`, `bootstrap.test.ts`, `sdk-tools.test.ts` |
| `learn/semaphore.ts` | `relay-task5-findings.test.ts`, `semaphore.test.ts` |
| `learn/skills-tool.ts` | `skills-tool.test.ts` |
| `learn/solver.ts` | `bootstrap.test.ts`, `leaf-learner.test.ts`, `learner.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `solver.test.ts`, `validate.test.ts` |
| `learn/tasks.ts` | `relay-task4-findings.test.ts`, `tasks.test.ts` |
| `learn/types.ts` | `doctor.test.ts`, `bootstrap.test.ts`, `cited-ids.test.ts`, `export.test.ts`, `grade.test.ts`, `knowledge-db.test.ts`, `knowledge-gate.test.ts`, `knowledge-store.test.ts`, `leaf-learner.test.ts`, `learn-cli.test.ts`, `learn-inject.test.ts`, `learned-block.test.ts`, `learner.test.ts`, `learning-db.test.ts`, `prompts.test.ts`, `relay-findings.test.ts`, `relay-task6-findings.test.ts`, `relay-task8-challenger.test.ts`, `relay-task9-findings.test.ts`, `report.test.ts`, `sdk-tools.test.ts`, `skills-tool.test.ts`, `solver.test.ts`, `validate.test.ts` |
| `learn/validate.ts` | `validate.test.ts` |
| `src/lockfile.ts` | `learn-cli.test.ts`, `lockfile.test.ts` |
| `src/logging.ts` | `doctor.test.ts`, `logging-append.test.ts`, `logging.test.ts`, `sync-cli-lock.test.ts`, `sync-hook-logging.test.ts` |
| `src/mcp-auth.ts` | `mcp-auth.test.ts` |
| `src/mcp-schemas.ts` | `mcp-schemas.test.ts`, `topic-tool.test.ts` |
| `src/mcp-tools.ts` | `digest-mcp.test.ts`, `learn-handlers.test.ts`, `mcp-tools.test.ts`, `topic-tool.test.ts` |
| `src/node-floor.ts` | `node-floor.test.ts` |
| `src/ollama-backend.ts` | `backfill-gpu-reservation.test.ts`, `digest-gpu-reservation.test.ts`, `gpu-reservation.test.ts`, `ollama-backend.test.ts`, `ollama-plain-reply.test.ts`, `summarizer-gpu-reservation.test.ts`, `summarizer-ollama-fallback.test.ts`, `summarizer-prompt-budget.test.ts`, `sync-gpu-reservation.test.ts`, `topic-job.test.ts` |
| `src/orphan-reaper.ts` | `orphan-reaper.test.ts` |
| `src/parser.ts` | `codex-transcripts.test.ts`, `integration.test.ts`, `parser-tool-result.test.ts`, `parser.test.ts` |
| `src/paths.ts` | `codex-transcripts.test.ts`, `knowledge-db.test.ts`, `knowledge-store.test.ts`, `learn-cli.test.ts`, `learn-lock.test.ts`, `learning-store.test.ts`, `skills-tool.test.ts`, `paths.test.ts` |
| `src/priority.ts` | `priority.test.ts` |
| `src/prune.ts` | `prune.test.ts` |
| `src/redact.ts` | `mcp-read-redaction.test.ts`, `redact-patterns.test.ts`, `security-speed-helpers.test.ts` |
| `src/reentrancy.ts` | `backfill-cli-gpu-reservation.test.ts`, `digest-gpu-reservation.test.ts`, `digest-job.test.ts`, `digest-prompt-budget.test.ts`, `agent-runner.test.ts`, `reentrancy.test.ts`, `summarizer-api-env.test.ts`, `topic-job.test.ts`, `topic-phase.test.ts` |
| `src/search.ts` | `cosine-similarity.test.ts`, `cross-harness-recall.test.ts`, `integration.test.ts`, `multi-concept.test.ts`, `search-metadata-filters.test.ts`, `search-with-summary.test.ts`, `security-speed-helpers.test.ts`, `sync-incremental-and-db.test.ts` |
| `src/show.ts` | `mcp-read-redaction.test.ts`, `show.test.ts` |
| `src/stats.ts` | `stats-format.test.ts`, `stats.test.ts` |
| `src/summarizer.ts` | `ollama-plain-reply.test.ts`, `summarizer-api-env.test.ts`, `summarizer-claude-path.test.ts`, `summarizer-gpu-reservation.test.ts`, `summarizer-ollama-fallback.test.ts`, `summarizer-options.test.ts`, `summarizer-prompt-budget.test.ts`, `summarizer-text.test.ts`, `topic-job.test.ts` |
| `src/sync-banner.ts` | `sync-banner.test.ts` |
| `src/sync.ts` | `exclude-nested.test.ts`, `sync-empty-summary-audit.test.ts`, `sync-gpu-reservation.test.ts`, `sync-helpers.test.ts`, `sync-incremental-and-db.test.ts`, `sync-pending-and-legacy-retry.test.ts`, `sync-session-id.test.ts`, `sync-summary-retry.test.ts`, `sync.test.ts` |
| `src/topic-db.ts` | `topic-db.test.ts`, `topic-job.test.ts`, `topic-tool.test.ts` |
| `src/topic-format.ts` | `topic-format.test.ts`, `topic-prompts.test.ts` |
| `src/topic-job.ts` | `topic-job.test.ts` |
| `src/topic-phase.ts` | `topic-phase.test.ts` |
| `src/topic-prompts.ts` | `topic-prompts.test.ts` |
| `src/topic-validate.ts` | `topic-prompts.test.ts`, `topic-validate.test.ts` |
| `src/types.ts` | `codex-transcripts.test.ts`, `cross-harness-recall.test.ts`, `db-helpers.test.ts`, `db.test.ts`, `digest-prompt-budget.test.ts`, `digest-prompts.test.ts`, `embedding-migration-helpers.test.ts`, `oversized-message-guard.test.ts`, `prune.test.ts`, `search-with-summary.test.ts`, `summarizer-claude-path.test.ts`, `summarizer-gpu-reservation.test.ts`, `summarizer-text.test.ts`, `sync-incremental-and-db.test.ts`, `topic-prompts.test.ts`, `verify.test.ts` |
| `src/verify.ts` | `verify.test.ts` |

---

## Test File Details

| Test File | Imports from Source |
|-----------|---------------------|
| `test/agent-sdk-floor.test.ts` | 0 files |
| `test/allow-scripts-pin.test.ts` | 0 files |
| `test/archive-path-edges.test.ts` | 1 files |
| `test/archive-path.test.ts` | 1 files |
| `test/backfill-cli-gpu-reservation.test.ts` | 1 files |
| `test/backfill-gpu-reservation.test.ts` | 2 files |
| `test/backfill.test.ts` | 1 files |
| `test/claude-e2e-script.test.ts` | 0 files |
| `test/codex-doctor.test.ts` | 2 files |
| `test/codex-e2e-script.test.ts` | 0 files |
| `test/codex-hook-trust.test.ts` | 1 files |
| `test/codex-plugin.test.ts` | 0 files |
| `test/codex-skills.test.ts` | 0 files |
| `test/codex-support-extra.test.ts` | 1 files |
| `test/codex-support.test.ts` | 1 files |
| `test/codex-transcripts.test.ts` | 4 files |
| `test/constants.test.ts` | 1 files |
| `test/cosine-similarity.test.ts` | 1 files |
| `test/cross-harness-recall.test.ts` | 3 files |
| `test/db-helpers.test.ts` | 2 files |
| `test/db.test.ts` | 2 files |
| `test/deps-health.test.ts` | 1 files |
| `test/digest-compress.test.ts` | 2 files |
| `test/digest-db.test.ts` | 2 files |
| `test/digest-gpu-reservation.test.ts` | 6 files |
| `test/digest-hook.test.ts` | 5 files |
| `test/digest-inject.test.ts` | 2 files |
| `test/digest-job.test.ts` | 4 files |
| `test/digest-mcp.test.ts` | 5 files |
| `test/digest-prompt-budget.test.ts` | 5 files |
| `test/digest-prompts.test.ts` | 4 files |
| `test/digest-validate.test.ts` | 1 files |
| `test/doctor.test.ts` | 9 files |
| `test/embedding-migration-helpers.test.ts` | 3 files |
| `test/embedding-migration.test.ts` | 2 files |
| `test/embeddings-format.test.ts` | 2 files |
| `test/exclude-nested.test.ts` | 2 files |
| `test/global-setup.test.ts` | 0 files |
| `test/gpu-reservation.test.ts` | 2 files |
| `test/hooks.test.ts` | 0 files |
| `test/incremental-indexing.test.ts` | 1 files |
| `test/integration.test.ts` | 4 files |
| `learn/agent-runner.test.ts` | 3 files |
| `learn/bootstrap.test.ts` | 7 files |
| `learn/cited-ids.test.ts` | 2 files |
| `learn/export.test.ts` | 6 files |
| `learn/grade.test.ts` | 2 files |
| `learn/knowledge-db.test.ts` | 5 files |
| `learn/knowledge-gate.test.ts` | 3 files |
| `learn/knowledge-store-write-lock.test.ts` | 1 files |
| `learn/knowledge-store.test.ts` | 4 files |
| `learn/leaf-learner.test.ts` | 7 files |
| `learn/learn-cli.test.ts` | 9 files |
| `learn/learn-config.test.ts` | 1 files |
| `learn/learn-handlers.test.ts` | 7 files |
| `learn/learn-inject.test.ts` | 4 files |
| `learn/learn-lock.test.ts` | 2 files |
| `learn/learned-block.test.ts` | 5 files |
| `learn/learned-text-screen.test.ts` | 1 files |
| `learn/learner.test.ts` | 7 files |
| `learn/learning-db.test.ts` | 3 files |
| `learn/learning-store.test.ts` | 3 files |
| `learn/prompts.test.ts` | 2 files |
| `learn/relay-challenger.test.ts` | 2 files |
| `learn/relay-findings.test.ts` | 3 files |
| `learn/relay-task4-findings.test.ts` | 4 files |
| `learn/relay-task5-findings.test.ts` | 1 files |
| `learn/relay-task6-findings.test.ts` | 5 files |
| `learn/relay-task7-findings.test.ts` | 1 files |
| `learn/relay-task8-challenger.test.ts` | 7 files |
| `learn/relay-task9-findings.test.ts` | 7 files |
| `learn/report.test.ts` | 6 files |
| `learn/sdk-tools.test.ts` | 2 files |
| `learn/semaphore.test.ts` | 1 files |
| `learn/skills-tool.test.ts` | 6 files |
| `learn/solver.test.ts` | 6 files |
| `learn/tasks.test.ts` | 3 files |
| `learn/validate.test.ts` | 7 files |
| `test/lockfile.test.ts` | 1 files |
| `test/logging-append.test.ts` | 1 files |
| `test/logging.test.ts` | 1 files |
| `test/mcp-auth.test.ts` | 1 files |
| `test/mcp-protocol.test.ts` | 0 files |
| `test/mcp-read-redaction.test.ts` | 2 files |
| `test/mcp-schemas.test.ts` | 1 files |
| `test/mcp-tools.test.ts` | 2 files |
| `test/multi-concept.test.ts` | 2 files |
| `test/node-floor.test.ts` | 1 files |
| `test/ollama-backend.test.ts` | 1 files |
| `test/ollama-plain-reply.test.ts` | 2 files |
| `test/orphan-reaper.test.ts` | 1 files |
| `test/oversized-message-guard.test.ts` | 3 files |
| `test/parser-tool-result.test.ts` | 1 files |
| `test/parser.test.ts` | 1 files |
| `test/paths.test.ts` | 1 files |
| `test/priority.test.ts` | 1 files |
| `test/prune.test.ts` | 3 files |
| `test/query-prefix.test.ts` | 1 files |
| `test/rebuild-native.test.ts` | 0 files |
| `test/redact-patterns.test.ts` | 1 files |
| `test/reentrancy.test.ts` | 1 files |
| `test/runtime-imports.test.ts` | 1 files |
| `test/search-agent-template.test.ts` | 0 files |
| `test/search-metadata-filters.test.ts` | 2 files |
| `test/search-with-summary.test.ts` | 2 files |
| `test/security-speed-helpers.test.ts` | 3 files |
| `test/show.test.ts` | 1 files |
| `test/stats-format.test.ts` | 1 files |
| `test/stats.test.ts` | 1 files |
| `test/summarizer-api-env.test.ts` | 2 files |
| `test/summarizer-claude-path.test.ts` | 2 files |
| `test/summarizer-gpu-reservation.test.ts` | 3 files |
| `test/summarizer-ollama-fallback.test.ts` | 2 files |
| `test/summarizer-options.test.ts` | 1 files |
| `test/summarizer-prompt-budget.test.ts` | 2 files |
| `test/summarizer-text.test.ts` | 2 files |
| `test/sync-banner.test.ts` | 1 files |
| `test/sync-cli-args.test.ts` | 0 files |
| `test/sync-cli-lock.test.ts` | 1 files |
| `test/sync-cli-reentrancy.test.ts` | 0 files |
| `test/sync-empty-summary-audit.test.ts` | 1 files |
| `test/sync-gpu-reservation.test.ts` | 2 files |
| `test/sync-helpers.test.ts` | 2 files |
| `test/sync-hook-gpu-reservation.test.ts` | 0 files |
| `test/sync-hook-learn-pids.test.ts` | 0 files |
| `test/sync-hook-logging.test.ts` | 1 files |
| `test/sync-incremental-and-db.test.ts` | 4 files |
| `test/sync-pending-and-legacy-retry.test.ts` | 1 files |
| `test/sync-session-id.test.ts` | 1 files |
| `test/sync-summary-retry.test.ts` | 1 files |
| `test/sync.test.ts` | 1 files |
| `test/test-env.test.ts` | 0 files |
| `test/tool-calls-cascade.test.ts` | 1 files |
| `test/topic-db.test.ts` | 1 files |
| `test/topic-format.test.ts` | 1 files |
| `test/topic-job.test.ts` | 6 files |
| `test/topic-phase.test.ts` | 3 files |
| `test/topic-prompts.test.ts` | 6 files |
| `test/topic-tool.test.ts` | 5 files |
| `test/topic-validate.test.ts` | 1 files |
| `test/verify.test.ts` | 4 files |
| `test/version-consistency.test.ts` | 0 files |
