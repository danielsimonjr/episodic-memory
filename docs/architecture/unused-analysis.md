<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Unused Files and Exports Analysis

## Summary

- **Files with no in-repo importer**: 14
- **Dormant files**: 58
  - **Orphaned (reachable from nothing)**: 15
  - **Test-only (only a test reaches them)**: 43
- **Potentially unused exports**: 114
  - **Unreferenced anywhere**: 4
  - **Referenced in their own module**: 110
  - **Not classified**: 0

## Caveats

- A literal relative `import(...)` is a graph edge. A runtime call is a namespace use (`*`), so the exports of that file count as used. A type-position `import(...).Name` counts only `Name`, and `typeof import(...)` counts none. A dynamic import built from a variable or a template, and other runtime loads (e.g. `new Worker(path)`), are still invisible -- a file or export reached ONLY through one of those is reported as no-importer/unreferenced even though it may be live.
- `noImporterFiles` is NOT a deletion-candidate list. A file with zero in-repo importers is expected, not suspicious, for: a standalone script invoked directly (e.g. a smoketest run via `node script.mjs`, never `import`ed by anything), or a build/lint config file loaded by its own tool rather than by source code (e.g. `eslint.config.mjs`, read by eslint itself). Cross-check against package.json scripts / tool configs before treating any entry here as dead.
- Only NAMED exports are analysed (`FileNode.exports` carries named exports only) -- `export default` usage is not checked here.
- The split of exports into `referencedInModule` and `unreferencedAnywhere` is a TEXT-LEVEL heuristic. The analysis counts whole-identifier occurrences in the source of the defining file, minus the declaration site itself. The count is not an AST reference count. The analysis can over-count a name that also appears in a string literal or comment. When the source text cannot be read (no `RepoGraph.root_path`, or the file is missing), the export lands in `unclassifiedExports`. The analysis does not guess a bucket for it.
- `unreferencedAnywhereNotes`'s dynamic-import check (`_dynamic_import_referrers`) only sees `import(...)` calls with a LITERAL string specifier. A dynamic import built from a variable or template literal (e.g. `import(`./cmds/${name}.js`)`, a command-dispatcher pattern) is invisible to it -- 'found none' in a note means no LITERAL match was found, NOT that nothing imports the file.

## Dormant files: orphaned

Source files that no root and no test reaches. Verify each one before you delete it.

- `cli/digest-hook.js`
- `cli/episodic-memory.js`
- `cli/forward-child.js`
- `cli/index-conversations.js`
- `cli/mcp-server-wrapper.js`
- `cli/search-conversations.js`
- `cli/sync-hook.js`
- `src/backfill-cli.ts`
- `src/doctor-cli.ts`
- `src/learn-cli.ts`
- `src/search-cli.ts`
- `src/show-cli.ts`
- `src/stats-cli.ts`
- `src/sync-cli.ts`
- `vendor/onnxruntime-web-stub/index.js`

## Dormant files: test-only

Source files that only a test reaches. They ship nothing, but a test uses them.

- `cli/ensure-deps.js`
- `src/backfill.ts`
- `src/codex-hook-trust.ts`
- `src/deps-health.ts`
- `src/digest-compress.ts`
- `src/digest-job.ts`
- `src/digest-phase.ts`
- `src/digest-prompts.ts`
- `src/doctor-learn.ts`
- `src/doctor.ts`
- `src/learn/agent-runner.ts`
- `src/learn/bootstrap.ts`
- `src/learn/cited-ids.ts`
- `src/learn/cli-main.ts`
- `src/learn/export.ts`
- `src/learn/grade.ts`
- `src/learn/knowledge-db.ts`
- `src/learn/knowledge-gate.ts`
- `src/learn/leaf-learner.ts`
- `src/learn/learn-handlers.ts`
- `src/learn/learn-lock.ts`
- `src/learn/learned-block.ts`
- `src/learn/learner.ts`
- `src/learn/learning-db.ts`
- `src/learn/learning-store.ts`
- `src/learn/prompts.ts`
- `src/learn/report.ts`
- `src/learn/sdk-tools.ts`
- `src/learn/semaphore.ts`
- `src/learn/solver.ts`
- `src/learn/tasks.ts`
- `src/learn/usage.ts`
- `src/learn/validate.ts`
- `src/logging.ts`
- `src/orphan-reaper.ts`
- `src/priority.ts`
- `src/stats.ts`
- `src/sync-banner.ts`
- `src/sync.ts`
- `src/topic-job.ts`
- `src/topic-phase.ts`
- `src/topic-prompts.ts`
- `src/topic-validate.ts`

## Files with no in-repo importer

No file of this repository imports these files. Do not use the list as a deletion list.

- `cli/digest-hook.js`
- `cli/episodic-memory.js`
- `cli/index-conversations.js`
- `cli/mcp-server-wrapper.js`
- `cli/search-conversations.js`
- `cli/sync-hook.js`
- `src/backfill-cli.ts`
- `src/doctor-cli.ts`
- `src/learn-cli.ts`
- `src/search-cli.ts`
- `src/show-cli.ts`
- `src/stats-cli.ts`
- `src/sync-cli.ts`
- `vendor/onnxruntime-web-stub/index.js`

## Exports unreferenced anywhere

No other file imports these names, and their own module does not use them.

- `src/learn/learn-inject.ts`: `readLearnedBlockCapped`
- `src/mcp-schemas.ts`: `SearchInput`, `ShowConversationInput`, `SkillsInput`

### Notes

- `src/learn/learn-inject.ts` `readLearnedBlockCapped`: Checked for a dynamic import() call with a LITERAL string specifier resolving to 'src/learn/learn-inject.ts' across the whole repo and found none. This scan can only see import() calls with a literal string specifier -- a dynamic import built from a variable or template literal (e.g. import(`./cmds/${name}.js`)) is invisible to it, so 'found none' means no LITERAL match was found, NOT that nothing imports this. 'readLearnedBlockCapped' may still be consumed via such a call. Also verify against consumption this scan cannot see at all (docs examples, published API surface, a runtime-built path/`new Worker(...)`) before deleting.
- `src/mcp-schemas.ts` `SearchInput`: Checked for a dynamic import() call with a LITERAL string specifier resolving to 'src/mcp-schemas.ts' across the whole repo and found none. This scan can only see import() calls with a literal string specifier -- a dynamic import built from a variable or template literal (e.g. import(`./cmds/${name}.js`)) is invisible to it, so 'found none' means no LITERAL match was found, NOT that nothing imports this. 'SearchInput' may still be consumed via such a call. Also verify against consumption this scan cannot see at all (docs examples, published API surface, a runtime-built path/`new Worker(...)`) before deleting.
- `src/mcp-schemas.ts` `ShowConversationInput`: Checked for a dynamic import() call with a LITERAL string specifier resolving to 'src/mcp-schemas.ts' across the whole repo and found none. This scan can only see import() calls with a literal string specifier -- a dynamic import built from a variable or template literal (e.g. import(`./cmds/${name}.js`)) is invisible to it, so 'found none' means no LITERAL match was found, NOT that nothing imports this. 'ShowConversationInput' may still be consumed via such a call. Also verify against consumption this scan cannot see at all (docs examples, published API surface, a runtime-built path/`new Worker(...)`) before deleting.
- `src/mcp-schemas.ts` `SkillsInput`: Checked for a dynamic import() call with a LITERAL string specifier resolving to 'src/mcp-schemas.ts' across the whole repo and found none. This scan can only see import() calls with a literal string specifier -- a dynamic import built from a variable or template literal (e.g. import(`./cmds/${name}.js`)) is invisible to it, so 'found none' means no LITERAL match was found, NOT that nothing imports this. 'SkillsInput' may still be consumed via such a call. Also verify against consumption this scan cannot see at all (docs examples, published API surface, a runtime-built path/`new Worker(...)`) before deleting.

## Exports referenced in their own module

No other file imports these names, but their own module uses them.

- `cli/forward-child.js`: `exitCodeFor`
- `src/api-endpoint.ts`: `ApiBaseUrlValidation`
- `src/deps-health.ts`: `nativeAddonPresent`
- `src/digest-compress.ts`: `CompressOptions`, `CompressResult`
- `src/digest-db.ts`: `citedExchangeIds`
- `src/digest-inject.ts`: `DEFAULT_DIGEST_MAX_CHARS`
- `src/digest-job.ts`: `ExchangeRow`, `toExchange`
- `src/digest-prompts.ts`: `BuiltPrompt`
- `src/digest-validate.ts`: `CitedLines`
- `src/doctor-learn.ts`: `LearnEntryCounts`, `LearnLatestRunSummary`
- `src/doctor.ts`: `CodexDoctorInputs`, `DoctorInputs`, `DoctorReport`, `StructuredDoctorReport`
- `src/gpu-reservation.ts`: `GpuReservation`
- `src/learn/agent-runner.ts`: `AgentRunOptions`, `AgentRunResult`, `BuildAgentQueryOptionsArgs`, `DISALLOWED_TOOLS`, `ProcessLister`, `addressFromResultText`, `isAgentSpawnTree`, `looksKilled`
- `src/learn/cited-ids.ts`: `DropReason`, `IdCitedLines`
- `src/learn/export.ts`: `ExportOptions`, `ExportResult`
- `src/learn/grade.ts`: `AnswerLocation`, `Grade`, `ParsedAnswer`, `parseJudgeScore`
- `src/learn/knowledge-gate.ts`: `GateAccepted`, `GateDeps`, `GateResult`
- `src/learn/leaf-learner.ts`: `LeafLearnerOptions`, `LeafResult`, `NAVIGATION_SLUG`, `PROCEDURE_MATCH_THRESHOLD`
- `src/learn/learn-config.ts`: `LearnApproveMode`
- `src/learn/learn-handlers.ts`: `HIDDEN_EXPAND_MESSAGE`, `LearnDigestArgs`, `LearnReadArgs`, `LearnSearchArgs`
- `src/learn/learn-lock.ts`: `LEARN_LOCK_NAME`, `LEARN_LOCK_STALE_MS`, `LEARN_PIDS_NAME`
- `src/learn/learned-text-screen.ts`: `ScreenKind`, `ScreenOptions`, `ScreenResult`
- `src/learn/learner.ts`: `FAILURE_CATEGORIES`, `LearnOptions`, `LearnResult`, `LearnSubset`, `MergeRecord`, `REFLECTION_SLUG_PREFIX`, `parseAssignment`, `splitFailures`
- `src/learn/pii-redactor.ts`: `PII_PATTERNS`
- `src/learn/prompts.ts`: `BootstrapStats`, `DiagnosePromptInput`, `DiagnosisFailure`, `EditBriefInput`, `MergeEntriesPromptInput`, `ReflectEvidence`, `ReflectPromptInput`, `SOLVER_ANSWER_FORMAT`, `SplitFailure`, `SplitPromptInput`
- `src/learn/report.ts`: `ReportMerge`, `ReportModel`, `SplitReport`
- `src/learn/sdk-tools.ts`: `LearnToolServerOptions`, `PROPOSAL_RECEIVED_MESSAGE`, `SERVER_NAME`
- `src/learn/semaphore.ts`: `Semaphore`
- `src/learn/solver.ts`: `SolveManyOptions`, `promptInputsForSnapshot`
- `src/learn/tasks.ts`: `GenerateTasksOptions`, `GenerateTasksResult`, `MIN_ASSISTANT_CHARS`, `MIN_USER_CHARS`, `SelectSourceOptions`, `paraphrasePrompt`, `parseParaphrase`, `promptLeaksAnswerKey`
- `src/learn/types.ts`: `SLUG_RE`
- `src/learn/validate.ts`: `ValidateOptions`, `ValidationResult`
- `src/logging.ts`: `LogLevel`
- `src/mcp-schemas.ts`: `ResponseFormatEnum`, `SearchModeEnum`, `TopicsActionEnum`
- `src/prune.ts`: `PruneOptions`, `PruneResult`
- `src/stats.ts`: `IndexStats`
- `src/sync-banner.ts`: `SyncHeadlineTotals`
- `src/topic-db.ts`: `TopicEdit`, `TopicEvent`, `TopicRange`, `TopicSession`, `TopicSessionStatus`, `TopicUnitHit`
- `src/topic-format.ts`: `TopicFootnote`, `TopicLink`, `TopicOutlineItem`, `TopicUnit`
- `src/topic-validate.ts`: `SLUG_PATTERN`

## Exports not classified

The analysis could not read the source of these names.

_None._
