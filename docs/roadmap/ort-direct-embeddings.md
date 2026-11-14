# Plan: embed with onnxruntime-node directly

## Goal

Remove `@huggingface/transformers` from the runtime. `src/embeddings.ts` tokenizes with `@huggingface/tokenizers` and runs the model with `onnxruntime-node`. The plan also fixes these defects:

- **Batch drift.** The transformers pipeline pads a batch. The q8 model then gives each text a different vector than the same text alone (cosine 0.965 to 0.997). The search embeds a query alone. The sync embeds a passage in a batch. The two vectors never match exactly.
- **Model cache in `node_modules`.** transformers keeps the model in `node_modules/@huggingface/transformers/.cache`. Each plugin version downloads the 34 MB model again.
- **No download integrity.** Nothing checks the downloaded model files.
- **Silent download.** The first `search` call of a fresh install downloads the model inside the MCP tool call. The person who runs the search sees nothing.

## Measured facts

- Direct ORT, one text per run, equals the transformers single-text output: max |difference| 4.5e-8 on 5 texts (short, unicode, 512-token cap, a 3-token text). The empty string was not in this set. The parity fixture covers the empty string.
- Direct ORT with a padded batch equals the transformers batch output: max |difference| 1.1e-7. The batch drift is therefore in the model, not in the pipeline code.
- One text per run is the fastest: 64 texts take 786 ms one at a time, 965 ms in batches of 8, 1216 ms in one batch of 64.
- The transformers tokenizer cuts at 512 tokens and keeps no final `[SEP]`. `tokenizer.json` has `truncation: null` and `padding: null`, so `Tokenizer.encode` returns every id and the code cuts.
- The model session accepts the three inputs `input_ids`, `attention_mask` and `token_type_ids` (the speed spike passes all three).
- Model: `Xenova/bge-small-en-v1.5`, revision `ea104dacec62c0de699686887e3f920caeb4f3e3`. The hub holds this revision; the hub size of the model file equals the local size. The sha256 values are local values of the files that transformers downloaded:
  - `tokenizer.json`, 711396 bytes, `d241a60d5e8f04cc1b2b3e9ef7a4921b27bf526d9f6050ab90f9267a1f9e5c66`
  - `tokenizer_config.json`, 366 bytes, `9261e7d79b44c8195c1cada2b453e55b00aeb81e907a6664974b4d7776172ab3`
  - `onnx/model_quantized.onnx`, 34014426 bytes, `6c9c6101a956d62dfb5e7190c538226c0c5bb9cb27b651234b6df063ee7dbfe4`
- `@huggingface/tokenizers` 0.1.3 is pure JavaScript. `new Tokenizer(tokenizerJson, tokenizerConfig)` and `encode(text)` are its API. `encode` adds `[CLS]` and `[SEP]`. The empty string and a whitespace-only string give the two special tokens `[101, 102]`. A 900-word text gives 902 ids, so the code must cut.
- `onnxruntime-node` 1.24.3 depends on `onnxruntime-common` 1.24.3 exactly, on `adm-zip` and on `global-agent`. Its `postinstall` stays denied (`allowScripts`, `test/allow-scripts-pin.test.ts`).

## Design

### `src/embedding-model.ts` (new)

- The top level imports Node built-ins, `paths.ts` (which imports `os`, `path` and `fs` only) and `fs-retry.ts` (which imports `fs` only). `db.ts` imports the module eagerly for the stamp string, so the module must load in every process and in the `FORBID_MODULES` probes.
- `EMBEDDING_MODEL`: repo, revision and the three files with size and sha256. This is the one source of the model identity.
- `modelDir()`: `EPISODIC_MEMORY_MODEL_DIR` when set, else `<superpowersDirPath()>/models/<repo>/<revision>`.
- `modelState()`: `ready` when each file exists with the correct size and sha256, else `missing` with the list of bad files. The hash of 34 MB runs once per process, at the first embedding.
- `ensureModel({ download })`:
  - `download: false` checks only. A missing or bad file throws `EmbeddingsUnavailableError`. The message names the path, the expected sha256 and the command that fetches the model.
  - `download: true` fetches each missing or bad file from `<HF_ENDPOINT or https://huggingface.co>/<repo>/resolve/<revision>/<file>`. The fetch has a timeout (`AbortSignal.timeout`, 10 minutes). The code streams the body to a unique temporary file (`<file>.tmp-<pid>-<random>`) in the same folder and hashes the stream. After the stream ends, the code checks the size and the sha256. A mismatch deletes the temporary file and throws. A match renames the file into place with `renameWithRetry` and 10 attempts (the antivirus scan of a new 34 MB file holds the file longer than 300 ms). When the rename fails and the target file has the correct hash, the code deletes the temporary file and accepts the target (another process won the race). Any other failure throws `EmbeddingsUnavailableError` with the cause. The final path never holds a file with a wrong hash.
  - Before each fetch, the function deletes `*.tmp-*` files of the model folder that are older than one hour (a killed process left them).
  - One in-flight promise per process. Overlapping calls share it.
- A download is never silent. Before each request, the function writes one stderr line with the file name, the size and the URL. After the hash check, it writes one more line.
- `EPISODIC_MEMORY_MODEL_OFFLINE=1` turns `download: true` into `download: false`.
- The download does not read `HTTPS_PROXY`. Node `fetch` ignores it. A host behind a proxy sets `EPISODIC_MEMORY_MODEL_DIR` to a folder that holds the files. The current code has the same limit.
- `HF_ENDPOINT` changes the URL only. The hash check rejects any file that a mirror changes.

### Who downloads

The embedding path never downloads. `initEmbeddings()` calls `ensureModel({ download: false })`. A `search`, an index run or a migration on a host without the model therefore fails at once with the path, the hash and the fetch command. Vector search stays off. Text search works.

Two places download. Neither one is on the MCP start path or the SessionStart hook path. `ensureDeps` (`cli/ensure-deps.js`) is synchronous and runs inline in `cli/mcp-server-wrapper.js:33` under the 30 s MCP start timeout, and inline in `cli/sync-hook.js:128` before the hook spawns the detached sync. A fetch there would block each start on a host whose connection hangs. The two places are:

- `syncAll` in `src/sync-cli.ts`, before the index phase. The sync runs detached in the background (`cli/sync-hook.js:140`), so a slow download blocks nothing. The fetch has a 10-minute timeout. A failed fetch writes one stderr line, writes the marker file `.model-fetch-failed` in the model folder, and the sync continues without embeddings. The next sync retries after 24 hours; `episodic-memory model fetch` deletes the marker and retries at once. This is the pattern of `ONNX_FAILED_MARKER` and `ONNX_RETRY_MS` in `cli/ensure-deps.js:67-73`.
- The new command `episodic-memory model fetch`, the manual path. It ignores the marker and prints the progress lines.

`doctor` reports `modelState()` and the marker. The new subcommand gets a `case` and a help line in `cli/episodic-memory.js`, a `dist/model-cli.js` entry, and a row in the e2e command registry (`test/e2e/cases.ts`), which fails on an unlisted subcommand.

`test/global-setup.ts` calls `ensureModel({ download: true })` once before the workers start.

### `src/embeddings.ts`

- `initEmbeddings()` calls `ensureModel({ download: false })`, then imports `onnxruntime-node` and `@huggingface/tokenizers` lazily, and creates the session and the tokenizer once. The function keeps one in-flight promise, so overlapping calls start one load. An import or load failure throws `EmbeddingsUnavailableError` with the cause.
- `generateEmbeddings(texts)` keeps the 2000-character cut, tokenizes each text, keeps the first 512 ids, and runs the model **once per text** with `input_ids`, `attention_mask` (all 1) and `token_type_ids` (all 0). It takes the mean over the tokens and normalizes to length 1. The empty string gives the mean over `[CLS]` and `[SEP]`.
- The exported functions and their signatures do not change.
- The error message no longer names `sharp` or `libvips`. It names `onnxruntime-node` and the binding path (`src/deps-health.ts` `ONNX_BINDING`).

### `src/model-u8.ts` (new)

- The q8 model multiplies uint8 activations by int8 weights in 72 `MatMulInteger` nodes. On an x86-64 CPU without VNNI, the u8s8 kernel of onnxruntime adds pairs of products in 16-bit lanes. A long text can saturate a lane, and its vector then differs from the vector of a VNNI CPU by up to 0.012.
- `rewriteMatMulWeightsToUint8` adds 128 to each weight and to each weight zero point, and sets the data type to uint8. The difference (weight - zero point) stays the same, so each integer product stays the same. The runtime then uses its u8u8 kernel, which does not saturate.
- The function edits the protobuf bytes and needs no protobuf library. The zero points are packed `int32_data`, so the function writes `raw_data` for each rewritten tensor. Every other field keeps its bytes.
- `initEmbeddings` gives the rewritten bytes to `InferenceSession.create`. The downloaded file and its pin do not change. `UINT8_MODEL_SHA256` pins the rewritten bytes, and a different digest fails the load.
- The session option `session.x64quantprecision` does not help this model: its graph transformers change no node.

### Stamp and version

- `EMBEDDING_STACK_PACKAGES` becomes `['onnxruntime-node', 'onnxruntime-common', '@huggingface/tokenizers']`. `onnxruntime-common` resolves from the folder of `onnxruntime-node`, as in the current code. `@huggingface/tokenizers` is a direct dependency and resolves from the root; the walk reaches the root after `onnxruntime-common`. The doc comment of `embedding-stack.ts` states this.
- `readEmbeddingStack` still returns packages only, so `test/e2e/install-versions.test.ts` keeps its parser.
- `embeddingStamp()` in `embedding-stack.ts` returns `readEmbeddingStack() + ' model=<repo>@<revision>'`. The sync migration (`src/sync-cli.ts` `runEmbeddingMigrationPhase`) reconciles with it. `initDatabase` (`src/db.ts`) stamps an empty index with it. No other code builds the string.
- The changed stamp re-embeds every row once. That re-embed also replaces the drifted batch vectors. `EMBEDDING_VERSION` does not change: `CLAUDE.md` gotcha 5 asks for a bump when the pipeline output changes, and the parity test shows the single-text output does not change. The stamp already forces the one re-embed that the batch fix needs. `CLAUDE.md` gotcha 5 gets this sentence.

### Dependencies

- Remove `@huggingface/transformers`, the `sharp` override, the `onnxruntime-web` override, `vendor/onnxruntime-web-stub/` and `test/onnxruntime-web-stub.test.ts`.
- Add exact direct pins: `onnxruntime-node` 1.24.3 and `@huggingface/tokenizers` 0.1.3. Keep `onnxruntime-common` 1.24.3 as a direct pin. Drop the `onnxruntime-node` and `onnxruntime-common` overrides. Keep the `adm-zip` and `hono` overrides. Keep `allowScripts.onnxruntime-node: false`.
- Regenerate `bun.lock` with bun 1.4.2, the CI version. Set `packageManager` to `bun@1.4.2`. The lock must hold no `sharp`, `@img/*`, `@huggingface/jinja`, `@huggingface/transformers` or `onnxruntime-web`.
- The `bundle` script drops `--external:sharp` and `--external:@huggingface/transformers`, and adds `--external:@huggingface/tokenizers`. `onnxruntime-node` stays external. The stamp then reads the code that runs.
- `test/runtime-imports.test.ts` passes only when `@huggingface/tokenizers` is in `dependencies`.
- `src/deps-health.ts` `JS_SENTINELS` checks `@huggingface/tokenizers/package.json` in place of transformers.
- `.github/workflows/ci.yml` line 29: the audit comment names `sharp`. Rewrite it for the remaining `onnxruntime-node` highs, or remove it when `bun audit` is clean.

### Environment variables

- `.mcp.json` whitelists `EPISODIC_MEMORY_MODEL_DIR`, `EPISODIC_MEMORY_MODEL_OFFLINE` and `HF_ENDPOINT`. `test/codex-plugin.test.ts` lists the same three names.
- `test/e2e/cases.ts` adds the two `EPISODIC_MEMORY_MODEL_*` names to the env registry.
- `test/test-env.ts` pins `EPISODIC_MEMORY_MODEL_DIR` to `join(tmpdir(), 'episodic-memory-test-models')`. `setup-env.ts` deletes every unlisted `EPISODIC_MEMORY_*` variable, and each test sets its own `EPISODIC_MEMORY_CONFIG_DIR`. Without the pin, each test would look for the model in its own config folder.
- `test/global-setup.ts` runs in the main vitest process, where `test.env` and `setup-env.ts` do not apply. The file sets `process.env` from `TEST_ENV` before it imports `embedding-model.ts`. The global setup and the workers then use one folder.
- The e2e harness (`test/e2e/harness.ts`) runs the CLI in a sandbox, requires each `PATH_VARS` entry under the sandbox root, and `test/e2e/cli-flags.test.ts` runs `search --vector`. Neither `PATH_VARS` nor `OPTIONAL_PATH_VARS` (`harness.ts:102-112`) allows a path outside the root. The harness gets a third list, `SHARED_PATH_VARS = ['EPISODIC_MEMORY_MODEL_DIR']`: `buildEnv` copies each one from `TEST_ENV`, exempts it from `isUnderRoot`, and sets `EPISODIC_MEMORY_MODEL_OFFLINE=1`. The dead-entry check of `test/e2e/cases.ts` learns the two names. The sandbox then reads the model that the global setup fetched and makes no request. `vitest.e2e.config.ts` already runs `test/global-setup.ts`, so an e2e-only run also has the model.

### Tests

Tests 1 and 2 exist in `test/embedding-parity.test.ts` with the fixture `test/fixtures/embedding-parity/vectors.json` (7 cases: short, unicode, over-512-tokens, over-2000-chars, query, empty, exchange). The other tests are written before the code and are RED where the behavior is new.

1. **Parity fixture.** Vectors from the transformers code, one text per call. The test requires max |difference| < 1e-4 and cosine > 0.9999, because the q8 kernels vary between CPUs. GREEN with the current code; must stay GREEN.
2. **Batch equals single.** `generateEmbeddings(texts)[i]` equals the fixture vector of `texts[i]`. RED with the current code (cosine 0.965 to 0.997 against a floor of 0.9999).
3. **Model download.** A local HTTP server serves the files from a temporary folder and counts requests. Cases: a missing file downloads and passes the hash; a wrong hash throws, leaves no file at the final path and no temporary file; a ready folder makes no request; `download: false` with a missing file throws a message that names the path, the hash and the fetch command; `EPISODIC_MEMORY_MODEL_OFFLINE=1` makes no request; a stale temporary file is removed; a rename failure with a correct target file succeeds (inject the rename seam); two child processes that fetch the same folder both end ready. The test uses small fixture bytes with their own sha256, not the 34 MB model.
4. **Stamp.** `embeddingStamp()` equals `readEmbeddingStack() + ' model=Xenova/bge-small-en-v1.5@ea104dacec62c0de699686887e3f920caeb4f3e3'`. `test/embedding-stack.test.ts` writes the three new package names and expects the new strings.
5. The `FORBID_MODULES` checks in `test/digest-hook.test.ts` and `test/mcp-protocol.test.ts` forbid `onnxruntime-node,@huggingface/tokenizers` in place of the removed package.
6. `test/embeddings-unavailable.test.ts` mocks `onnxruntime-node` in place of transformers and expects the new message (`/onnxruntime/i`, no `sharp|libvips`). `test/search-embeddings-unavailable.test.ts` and `test/sync-embeddings-unavailable.test.ts` hold the old message text as a constant; update the constant.
7. `test/global-setup.test.ts` imports `env` from transformers. Rewrite it against `modelDir()` and `modelState()`.
8. `test/ensure-deps-prune.test.ts`, `test/deps-health.test.ts` and `test/ensure-deps-repair.test.ts` create the transformers sentinel. They create the tokenizers sentinel.
9. `test/embeddings-unavailable.test.ts` and the three tests above run under the CI-pinned bun, and the full suite runs before the push.

### Docs

Grep the tree for `transformers`, `sharp`, `libvips`, `onnxruntime-web` and `Transformers.js` after the final edit. Each hit outside `CHANGELOG.md` and `docs/roadmap/dependency-minimization.md` history is updated:

- `CLAUDE.md`: patch table, gotchas 1, 4 and 5, the `vendor/` tree, the test-state paragraph, the debug recipes, the env whitelist.
- `README.md` lines 261 and 594 (Transformers.js).
- `docs/roadmap/README.md` (the roadmap index), `docs/roadmap/focus-areas/embeddings.md` (names `all-MiniLM-L6-v2`, which is not the model), `docs/roadmap/now.md`, `docs/roadmap/next.md`, `docs/roadmap/dependency-minimization.md` (a closing section), `docs/roadmap/upstream-triage.md`.
- Code comments that name transformers as the heavy stack: `src/sync-cli.ts`, `src/learn-cli.ts`, `src/learn/learn-config.ts`, `src/learn/types.ts`, `src/priority.ts`, `src/reentrancy.ts`, `test/helpers/forbid-modules.mjs`.
- `docs/architecture` (regenerated), `CHANGELOG.md` and `todo.md`.

## Out of scope

- bge-small-en-v1.5 expects CLS pooling. The code uses mean pooling. A change of pooling changes retrieval quality and needs its own decision.
- A migration of the old cache in `node_modules`. The new path downloads the model once.
- Proxy support for the download.

## Risks

- A CPU or ORT build gives different q8 results. The parity test uses a tolerance.
- A later `@huggingface/tokenizers` release changes the ids. The exact pin and the parity test catch that.
- Offline hosts cannot download. `EPISODIC_MEMORY_MODEL_DIR` points at a folder that holds the files. The error message names the folder and the hashes.
- The CI runner downloads the model on every run, as with the current code. An `actions/cache` step keyed on the revision removes the download; optional.
