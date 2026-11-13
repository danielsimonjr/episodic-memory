# Dependency minimization plan

This plan reduces the install footprint and the native-build risk of the episodic-memory plugin.
Each workstream states the change, the saving, the risk, the acceptance test, the rollback and the verdict.
The plan does not remove every dependency. A dependency that stays has a stated reason in section 3.7.

Verdict values:

- **DO**: the PR has a place in the sequence of section 6.
- **DO LATER**: the work waits for the named condition.
- **KEEP**: the dependency or the code stays. The reason is given.

Units: decimal megabytes (MB = 10^6 bytes of file size).
A value marked **estimate** is arithmetic over measured rows, or a size that no install has confirmed.
An estimate becomes a measurement when the acceptance test of its PR runs.

## 1. Baseline

The measurements use the plugin cache copy of version 1.8.0, Windows x64, Node 26.13.0.
Method: the size walk of section 7. A nested package counts once.

| Direct dependency | Import sites (src, non-test) | Closure packages | Exclusive MB | Largest parts (MB) |
|---|---|---|---|---|
| @huggingface/transformers 4.2.0 | 1 (`src/embeddings.ts`) | 49 (48 exclusive) | 427.6 | onnxruntime-node 220.3; onnxruntime-web 134.5; transformers 44.3; @img/sharp-win32-x64 19.8 |
| @anthropic-ai/claude-agent-sdk 0.3.299 | 3 (`src/learn/agent-runner.ts`, `src/learn/sdk-tools.ts`, `src/summarizer.ts`) | 2 | 274.4 | claude-agent-sdk-win32-x64 269.2 (bundled Claude Code binary, version 2.1.299 in the SDK `manifest.json`) |
| better-sqlite3 13.0.3 | 25 files | 2 | 27.7 | prebuilds/ 16.9 (8 platforms); deps/ 10.3 |
| @modelcontextprotocol/server 2.0.0 | 1 (`src/mcp-server.ts`) | 3 | 7.6 | |
| zod ^4.6.6 | 2 | 1 | 0.0 (shared with the MCP server) | 6.1 own |
| onnxruntime-common 1.24.3 | 0 | 1 | 0.0 | hoist pin (section 3.5) |
| marked ^16.4.0 | 1 (`src/show.ts`) | 1 | 0.4 | |
| sqlite-vec ^0.1.7-alpha.2 (installed 0.1.9) | 1 (`src/db.ts`) | 2 | 0.3 | `vec0` extension in an optional platform package |

Totals (same tree, same method):

| Item | Value |
|---|---|
| `node_modules`, file-size total | 839.2 MB |
| `node_modules`, top-level entries (dot entries excluded) | 168 |
| transformers and Agent SDK, exclusive | 702.1 MB (83.7% of 839.2 MB) |
| devDependency-only subtree | 78.4 MB, 54 packages |
| Claude Code on the measuring host (`claude --version`) | 2.1.318, a native binary of 342 MB |

Parts of `onnxruntime-node/bin/napi-v6` (220.3 MB in total):

| Directory | MB |
|---|---|
| `darwin/arm64` | 36.2 |
| `linux/arm64` | 19.0 |
| `linux/x64` | 35.5 |
| `win32/arm64` | 67.3 |
| `win32/x64` | 62.2 |

Caveats:

- The walk does not follow peer dependencies. The install includes `@anthropic-ai/sdk` (4.4 MB) and `@modelcontextprotocol/sdk` (4.4 MB). No table row includes the two SDK packages.
- The walk skips symbolic links.
- The values are Windows x64 values. The Agent SDK binary, `onnxruntime-node` and the `better-sqlite3` prebuilds differ per platform.
- A Linux x64 install runs the `onnxruntime-node` postinstall (`script/install`). That script can download extra binaries into `bin/napi-v6/linux/x64`. A Linux figure needs its own measurement on Linux.
- The walk sums file sizes. A `du` report counts disk blocks and gives different values.

Dependency facts:

- The SDK `optionalDependencies` list eight platform packages: `linux-x64`, `linux-arm64`, `linux-x64-musl`, `linux-arm64-musl`, `darwin-x64`, `darwin-arm64`, `win32-x64` and `win32-arm64`.
- The `sqlite-vec` `optionalDependencies` list five platform packages. The `vec0` extension loads from one of them.
- `better-sqlite3` 13 ships prebuilds for eight platforms. A normal install compiles nothing.
- The repo has no `package-lock.json`. A plugin host install resolves the ranges in `package.json`.
- `cli/ensure-deps.js` runs `npm install --no-audit --no-fund` with no `--omit` flag. The devDependencies therefore install on every plugin host.

## 2. Repo facts that bind the plan

- The package is a fork of `obra/episodic-memory`. Fork divergence has an ongoing merge cost (`docs/roadmap/upstream-sync.md`). `package.json` is in the fork-patched set.
- `package.json` has an `overrides` block (`hono`, `sharp`, `adm-zip`, `onnxruntime-web`). A new override extends that block.
- `package.json` has no `files` field. The plugin cache holds the whole repo, so a folder inside the repo ships to every plugin host.
- The plugin runs under Claude Code and under Codex (`README.md`, `.codex-plugin/plugin.json`, codex-cli 0.130.0 or later). A Codex host can have no `claude` executable.
- `engines.node` is `>=22.0.0`. `src/node-floor.ts` sets `NODE_FLOOR` to `22.0.0`. CI runs Node 24 only.
- The repo tracks `dist/`. CI fails when a build of the commit differs from `dist/`.
- The `bundle` script marks these packages external: the Agent SDK, `@modelcontextprotocol/server`, `@modelcontextprotocol/core`, `sharp`, `onnxruntime-node`, `better-sqlite3`, `@huggingface/transformers` and `sqlite-vec`.
- `main` is protected. Every change uses a branch and a pull request.
- `.mcp.json` lists 13 names in `env_vars`, and 10 of them start with `EPISODIC_MEMORY_`. `CLAUDE.md` requires one `.mcp.json` line and one `test/codex-plugin.test.ts` row for each variable that the server reads.
- `CLAUDE.md` requires an `EMBEDDING_VERSION` bump for any change to the model, dtype, prefix, pooling, normalization or truncation.
- `CLAUDE.md` says that stdout of the MCP server belongs to JSON-RPC. A stray `console.log` or an inherited child stdout corrupts the protocol.

Install path:

- `cli/ensure-deps.js` is on the start path of `cli/mcp-server-wrapper.js` and of the SessionStart hook `cli/sync-hook.js`. `src/doctor.ts` calls the same health check.
- `ensureDeps` calls `repairPlan` from `dist/deps-health.js`. The function returns at once when the plan is `none`. The function throws on any repair failure. A throw stops the MCP server start.
- `repairPlan` checks three JS sentinels (`better-sqlite3/lib/index.js`, `@huggingface/transformers/package.json`, `onnxruntime-common/package.json`) and the `better-sqlite3` binding. The function checks no other package.
- The `runNpm` argument list in `cli/ensure-deps.js` is the only place for install flags.

Measured facts that the workstreams use:

- The node build of `@huggingface/transformers` does not import `onnxruntime-web`. The node build inlines its own copy of the web bundle. Zero files under `@huggingface/transformers/types` mention `onnxruntime-web`.
- The node build has one static `import sharp from "sharp"`. `sharp` throws at import when its `@img/sharp-<platform>` package is absent.
- An install with `--omit=optional` removes `@img/sharp-<platform>` and the `sqlite-vec` platform package. The transformers import and the database open then fail. **No step of this plan uses `--omit=optional`.**
- The `.transaction(` call appears 12 times and the `.pragma(` call appears 12 times in non-test source.
- 25 source files import `better-sqlite3`: 18 use `import type` and 7 use a value import.
- `tsx` has no import or command use in `cli`, `scripts`, `src`, `test`, `hooks` or `.github`. Two test fixture files hold the text as data.
- `EMBEDDING_VERSION` is 1 (`src/embedding-migration.ts`). The model is `Xenova/bge-small-en-v1.5`, q8, mean pooling, normalized, 384 dimensions.

## 3. Workstreams

### 3.1 Quick wins (PR 1)

**What changes.**

- Remove `tsx` from `devDependencies`. No file uses `tsx`.
- Remove `@types/marked`. `marked` 16 ships its own types (`types: ./lib/marked.d.ts`).
- Change the `sqlite-vec` range from `^0.1.7-alpha.2` to `^0.1.9`. The installed version is 0.1.9. The old range sets only a prerelease floor.
- Regenerate `bun.lock` with the Bun version that `.github/workflows/ci.yml` pins.
- Correct the comment in `src/deps-health.ts` that says the protocol test checks the first stderr line. `test/mcp-protocol.test.ts` uses `toContain`.

**Saving.** `tsx` 12.4 MB and 3 packages on a plugin host. `@types/marked` 0.03 MB and 1 package. A repo checkout has no runtime saving. Section 3.2 includes these packages, so the two savings do not add.

**Risk.** The `marked` types can differ from `@types/marked` 5. The typecheck gate catches a difference.

**Acceptance test.**

1. `bun install --frozen-lockfile` exits 0.
2. `bun run typecheck` exits 0.
3. `bun run test` passes. The test count obeys the rule of section 5.
4. `bun run build` exits 0. `git diff --ignore-cr-at-eol --exit-code -- dist` exits 0.
5. In a fresh scratch install, `test ! -d node_modules/tsx` passes. `test ! -d node_modules/@types/marked` passes.

**Rollback.** Section 8.

**Verdict: DO.** The change removes unused packages and moves the range to the installed release.

### 3.2 No devDependencies on plugin hosts: `--omit=dev` (PR 2)

**What changes.** Add `--omit=dev` to the `runNpm` arguments of the install in `cli/ensure-deps.js`. Repo checkouts keep the devDependencies.
`--omit=dev` is not `--omit=optional`. The optional platform packages stay.

**Saving.** 78.4 MB and 54 packages on a plugin host (measured subtree; estimate until installed).
The subtree holds `vitest` (26.3 MB), `typescript` (23.6 MB), `tsx` (12.4 MB), `esbuild` (10.8 MB), `@types/node` (2.7 MB) and `@types/better-sqlite3` (2.6 MB).
The saving applies to a fresh install. A new plugin version gets a new cache directory and a fresh install.

**Risk.**

- The root `postinstall` (`scripts/rebuild-native.mjs`) runs during the install. The script imports Node built-ins only.
- A runtime file that imports a devDependency fails on a plugin host. CI cannot show this failure, because CI installs the full tree.

**Acceptance test.**

1. Static check. Collect every bare import specifier in `dist/**/*.js`, `cli/*.js`, `scripts/rebuild-native.mjs` and each script that `hooks/hooks.json` names. No specifier may resolve to a package of the devDependency-only subtree. A specifier that does fails the PR.
2. Make a fresh scratch install with the flag. The size-walk total falls by 78.4 MB, inside the band of section 6.
3. In the same tree, `node cli/mcp-server-wrapper.js` receives one `initialize` request on stdin. Stdout holds the JSON-RPC response and no other bytes.
4. In the same tree, `node cli/episodic-memory.js doctor` reports a healthy tree.
5. In the same tree, the fixture search of section 7 returns the known passage as the first hit.

**Rollback.** Section 8. The next fresh install installs the devDependencies again.

**Verdict: DO.** The change is one flag with a measured saving. PR 2 lands before any PR that edits `cli/ensure-deps.js` for other reasons.

### 3.3 Dead weight inside the transformers closure

This workstream changes no embedding code. The embedding backend stays the same.

#### 3.3a Stub `onnxruntime-web` (PR 3)

**What changes.**

- Add a placeholder package inside the repo: `vendor/onnxruntime-web-stub/package.json`. The name is `onnxruntime-web`. The version is `0.0.0-stub`.
- The main file of the stub throws `onnxruntime-web is stubbed out; the node build does not use it`. A future import therefore fails loudly.
- Add `"onnxruntime-web": "file:./vendor/onnxruntime-web-stub"` to `overrides`. An override cannot delete a package. An override can only replace a package.
- Do not publish a package. A published placeholder is an outward-facing act and adds a supply-chain trust.
- Regenerate `bun.lock`.
- Remove the `protobufjs` override and the `protobufjs` entry of `allowScripts`. Only `onnxruntime-web` reaches `protobufjs`, so with the stub no package reaches `protobufjs`.

npm and bun accept the `file:` override. npm links `node_modules/onnxruntime-web` to the stub. bun writes the stub into `bun.lock` and installs no `onnxruntime-web` directory. Neither tree holds the registry package.

**Saving.** 140.7 MB and 18 packages at the `bun.lock` versions. The figure is the install-cache size of the 18 removed lock entries.
The `onnxruntime-web` directory is 133.9 MB. The other 6.8 MB belongs to packages that only `onnxruntime-web` reaches.
A plugin host installs with npm and no lockfile. That install resolves a later `onnxruntime-web` release. On that host, two fresh npm trees differ by 151.9 MB.

**Risk.**

- `bun` and `npm` resolve an override differently. The acceptance test installs with both.
- A later transformers release can import `onnxruntime-web` in the node build. The stub throws, and the embedding tests fail loudly.
- The web export of transformers cannot run with the stub. The plugin does not use the web export.

**Acceptance test, in this order.** Each step can fail.

1. `bun run typecheck` exits 0 with the override.
2. Run `bun install --frozen-lockfile` with the CI Bun version. Run `npm install --no-audit --no-fund`. In the npm tree, `node_modules/onnxruntime-web/package.json` names the stub. The bun tree holds no `onnxruntime-web` directory.
3. If either installer rejects the `file:` override, PR 3 stops. This plan then gets a new decision. The plan does not fall back to a published package.
4. The size-walk total of each fresh install falls by 140.7 MB, inside the band of section 6.
5. `import('@huggingface/transformers')` succeeds. One embedding call returns a vector of 384 dimensions.
6. The embedding test files pass.
7. The fixture search of section 7 returns the known passage as the first hit.

**Rollback.** Section 8. The revert removes the override and the stub. Run `bun install` to regenerate `bun.lock`.

**Verdict: DO.** Step 2 passes under both installers. The step is the largest removal that keeps the embedding stack unchanged.

#### 3.3b Prune idle `onnxruntime-node` binaries (PR 4)

**What changes.**

- Add `pruneOptionalWeight(nodeModules)` to `cli/ensure-deps.js`.
- The function removes every directory `onnxruntime-node/bin/napi-v6/<platform>/<arch>` except the directory that equals `process.platform` and `process.arch`.
- The function then removes each `<platform>` directory that is empty.
- A Node x64 process on Windows ARM64 loads the x64 binding, and `process.arch` reports `x64`. The key therefore names the binding that the process loads.
- `ensureDeps` calls the function after the repair block and before `return`, on every call. The call includes the `none` case, so the function prunes a healthy tree too. The early `return` for `none` changes for this reason.
- When nothing remains to remove, the function does only `existsSync` checks.
- The function runs after `npm install` and after the `onnxruntime-node` postinstall.
- `src/deps-health.ts` does not check the idle directories. A pruned tree stays healthy.

**Best-effort rule (shared with section 3.4).**

- The prune and the SDK package removal are best effort.
- A removal calls `fs.rmSync` with `recursive`, `force`, `maxRetries: 5` and `retryDelay: 200`. The retries cover a file that Defender or a running process holds.
- A removal failure writes one line to stderr. The function then returns.
- A removal failure never changes the return value of `ensureDeps`, and never throws.
- All output goes to stderr. Stdout of the wrapper belongs to JSON-RPC.

**Saving.** 158.1 MB on Windows x64, 0 packages (measured directory sizes; estimate until pruned). The `win32/x64` directory (62.2 MB) stays.

**Risk.**

- A later `npm install` re-extracts `onnxruntime-node` and restores the directories. The prune runs on every `ensureDeps` call, so the next call removes the directories again.
- A wrong key removes the binding that the process loads. The mutation test below catches that error.

**Acceptance test.**

1. A unit test builds a fake tree with three `<platform>/<arch>` pairs. One of the pairs is the running pair. After one call, only the running pair stays.
2. A second call changes nothing.
3. A mutated prune that removes the running pair fails test 1.
4. One `ensureDeps` call prunes a healthy fake tree with the idle directories.
5. A test makes one target read-only or locked. `ensureDeps` returns normally, and stderr holds exactly one line.
6. A fresh scratch install falls by 158.1 MB, inside the band of section 6. `doctor` reports a healthy tree.
7. The fixture search of section 7 returns the known passage as the first hit.

**Rollback.** Section 8. Then run `npm install --no-audit --no-fund` in the plugin root to restore the directories.

**Verdict: DO.** PR 4 lands before the SDK PR, because PR 4 builds the best-effort helper that PR 5 uses.

### 3.4 Agent SDK native binary (PR 5)

The platform package `@anthropic-ai/claude-agent-sdk-<platform>` holds a bundled Claude Code binary (269.2 MB on Windows x64).
The SDK accepts `pathToClaudeCodeExecutable` (string). When the option is set, the SDK spawns that executable.
When the platform package is absent and the option is unset, the SDK throws `Native CLI binary for <platform> not found`.

**Decision: opt-in removal (option i).** The default install keeps the platform package. A host that sets `EPISODIC_MEMORY_CLAUDE_BIN` removes the package and gets the saving.
The plan rejects default removal (option ii).

Discriminators:

- A Codex host can have no `claude` executable. Under option (ii), the summarizer and the learn agent fail on every such host by default.
- The SDK serves Claude-session summaries and the learn agent. A Codex host that also indexes Claude sessions needs the SDK.
- The repo rule is "fail loudly, never fall back to a built-in". Under option (i), a host that does not opt in uses the bundled binary, which is on disk. A host that opts in uses the named executable or fails loudly.

**Configuration.**

- Unset: the module passes no executable option. The bundled binary runs.
- Set: the module passes the path as `pathToClaudeCodeExecutable`.
- The path names a native binary, or a `.js` or `.mjs` file. The SDK treats a path that ends in `.js`, `.mjs`, `.ts`, `.tsx` or `.jsx` as a script. The SDK spawns any other path as a native binary.
- A `.cmd` or `.ps1` shim is not valid. The probe rejects it with one stderr line.
- There is no PATH default. A PATH lookup is a second default, and the plan keeps one default only.

**What changes.**

1. **One resolution module.** A new module (name set in the PR) reads `EPISODIC_MEMORY_CLAUDE_BIN`. `src/summarizer.ts`, `src/learn/agent-runner.ts` and `cli/ensure-deps.js` use the module. No other module reads the variable. `cli/ensure-deps.js` imports the compiled module from `dist/`.
2. **One place to set the variable.** The opt-in is the environment variable and nothing else. The installer, the MCP wrapper, the SessionStart hook and the CLI read the variable through the module. The docs name one place to set the variable. All four processes inherit that place: the Claude Code `env` setting or the user shell profile.
3. **Environment whitelist.** The server process reads the variable. The PR adds the name to `env_vars` in `.mcp.json` and a row to `test/codex-plugin.test.ts`.
4. **Bounded version probe.** When the variable is set, the module runs `<path> --version` once per process and caches the result.
   - A `.js` or `.mjs` path runs under `process.execPath`. A native path runs directly.
   - The probe captures the child output with `stdio: ['ignore', 'pipe', 'pipe']`. The probe writes only through `console.error`.
   - The probe parses `^\d+\.\d+\.\d+` from stdout. The compare is a numeric compare of three parts.
   - The probe has a timeout. The bound follows the codex probe in `src/summarizer.ts` (`EPISODIC_MEMORY_CODEX_BIN`).
   - The floor is the `version` field of `@anthropic-ai/claude-agent-sdk/manifest.json`. The module reads the file at run time. The manifest is in the SDK package, not in the platform package, so the manifest stays on disk.
   - A failed probe, a timeout or a version below the floor is an error. The error writes one stderr line. The line names the path, the found version and the floor. The run stops.
   - The probe does not run for the bundled binary.
5. **Install-time removal.** In `cli/ensure-deps.js`, when the variable is set and the probe passes, remove every directory that matches `@anthropic-ai/claude-agent-sdk-*` under `node_modules`.
   - The SDK package itself (no suffix) stays.
   - On Linux, npm can install more than one candidate (for example `-linux-x64` and `-linux-x64-musl`). The pattern removes every candidate directory.
   - The removal runs in `pruneOptionalWeight` on every call, under the best-effort rule of section 3.3b.
   - The `runNpm` arguments do not change for this step.
6. **Runtime policy when the package is absent and the variable is unset.** The module checks the platform package directory before the SDK call. If the package is absent, the module writes one stderr line and the run stops.
   - The line names `EPISODIC_MEMORY_CLAUDE_BIN`.
   - The summarizer line also names the Ollama backend (`EPISODIC_MEMORY_SUMMARIZER_BACKEND=ollama`).
   - The run never falls back to a path that is not on disk.
7. **Health check.** `src/deps-health.ts` does not require the platform package. A tree without the package stays healthy.
8. **Documentation.** The architecture docs and `CLAUDE.md` describe the variable, the opt-in and the failure lines.

The plan does not use an `overrides` entry for the eight platform packages. An override applies to every host, and option (i) needs the default install to keep the package.

**Saving.** 269.2 MB and 1 package on each opt-in Windows x64 host (measured package size). The default install saves 0 MB. The SDK package without the platform package is 5.2 MB (estimate).

**Risk.**

- **Version coupling.** The SDK vendor tests the protocol against the bundled binary only. The floor blocks an older host binary. The floor has no ceiling, so a newer binary can change behaviour that the SDK does not test. The PR body records the live check.
- **Floor drift.** The root range is `^0.3.299`. A new SDK release can raise the floor. The error line names the floor and the found version, so the host owner knows to update Claude Code.
- **Data safety.** The SDK floor test (`test/agent-sdk-floor.test.ts`) protects against a binary that deletes session records. A host binary moves the runtime away from that test, so the version floor is mandatory.
- **Path drift.** A Claude Code update can move the host binary. The probe then fails loudly.

**Acceptance test.** Each item can fail.

1. A new test file covers the probe with a fake executable written as a `.mjs` file:
   - The fake prints the floor version. The probe passes.
   - The fake prints a version one step below the floor. The probe fails with one stderr line.
   - The fake sleeps past the timeout. The probe fails with the timeout error.
   - The path does not exist. The probe fails.
   - The path ends in `.cmd`. The probe rejects it.
2. A test checks that the floor equals the `version` field of the manifest. A changed manifest changes the floor.
3. With the variable unset and the package present, a spy counts zero probe runs.
4. With the variable unset and the package absent, the module writes the exact stderr line that names the variable.
5. One process tree runs the resolver with the variable set and with the variable unset. Each case gives the expected result.
6. A fake tree with `-linux-x64` and `-linux-x64-musl` loses both directories. The SDK package stays.
7. A test spawns the wrapper with a fake binary that prints to stdout. The wrapper stdout holds zero stray bytes.
8. `test/agent-sdk-floor.test.ts` stays and passes.
9. The `summarizer` and `learn` unit tests pass with the injected fake.
10. The PR updates the tests of `buildAgentQueryOptions` (`src/learn/agent-runner.ts`) and of the summarizer options builder. The executable field is absent when the variable is unset.
11. A fresh opt-in install falls by 269.2 MB, inside the band of section 6. `test ! -d` passes for the platform package. A fresh default install keeps the package.
12. Manual check, recorded in the PR body and not in CI: one live summary through the host binary on a Claude Code host. The record names the host binary version.

**Rollback.** Section 8. Then run `npm install --no-audit --no-fund` in the plugin root. The install restores the platform package.
`deps-health` does not treat a missing platform package as unhealthy, so `ensureDeps` never reinstalls the package by itself. Remove the variable from the host.

**Verdict: DO (opt-in; unset selects the bundled binary).** The default install does not change. Each opt-in host saves 269.2 MB.

### 3.5 Embeddings: keep, replace, or add a backend

| Option | Description | Saving over section 3.3 (estimate) | Verdict |
|---|---|---|---|
| A | Keep `@huggingface/transformers` after section 3.3 | 0 | **KEEP** until option B passes its gate |
| B | Call `onnxruntime-node` and `@huggingface/tokenizers` directly, with mean pooling and normalization in the repo | 65.5 MB, 6 packages | **DO LATER** |
| C | Opt-in Ollama embedding backend on `src/ollama-backend.ts` | 0 by default | **DO LATER** |

Embedding closure after sections 3.3a and 3.3b: 427.6 - 140.7 - 158.1 = 128.8 MB (estimate).

**Option B details.**

- B drops `@huggingface/transformers` (44.3 MB), `sharp` (0.96 MB), `@img/sharp-win32-x64` (19.8 MB), `detect-libc`, `@img/colour` and `@huggingface/jinja` (0.36 MB). The drop set is 65.5 MB and 6 packages (measured by reachability).
- B keeps `onnxruntime-node` (62.2 MB on Windows x64 after the prune) and `@huggingface/tokenizers` (0.30 MB).
- Closure after B: 128.8 - 65.5 = 63.3 MB (estimate). The PR measures the value again.
- B removes the `onnxruntime-common` hoist pin and the `@huggingface/transformers/package.json` sentinel in `src/deps-health.ts`. The esbuild externals and `package.json` change in the same PR.
- Risks: drift in the hub tokenizer files (`tokenizer.json`, `tokenizer_config.json`), the download path of the q8 model file, and the batch shape.

**Parity gate.**

- The PR generates reference vectors with the base commit code, on the PR branch. The PR commits the corpus and the vectors as fixtures. Nobody types the vectors by hand.
- The corpus has at least 50 passages and 20 prefixed queries. The corpus adds edge inputs: empty text, text over 2000 characters, non-ASCII text and a very long token run.
- The test uses the same truncation (2000 characters per passage), the same `BGE_QUERY_PREFIX`, the same pooling and the same normalization.
- Each vector pair has a cosine similarity of at least 0.9999. A lower value fails the gate.
- Negative control: a run with CLS pooling must fail the gate. The PR body shows the failed control run.

**`EMBEDDING_VERSION` rule.**

- If the parity gate passes, B keeps `EMBEDDING_VERSION`. The PR amends the `CLAUDE.md` rule to say: "a change that the parity gate proves equal to 0.9999 cosine needs no bump".
- If any pair falls below 0.9999, the PR bumps `EMBEDDING_VERSION`. The verdict for B then stays DO LATER until the release owner accepts a full re-embed.

**Option C details.**

- C builds on `src/ollama-backend.ts` (`EPISODIC_MEMORY_OLLAMA_URL` and the GPU-reservation check).
- The dimensions differ from 384. C writes under a new `EMBEDDING_VERSION` through `src/embedding-migration.ts`. A full re-embed of the fixture corpus is the acceptance test.
- C removes nothing by default. Transformers stays for hosts without Ollama.
- Tests keep the closed-port pin of the Ollama URL (`test/test-env.ts`, loaded by `vitest.config.ts`).

**Verdict: A KEEP. B DO LATER**: B waits for the parity corpus, the negative control and the `EMBEDDING_VERSION` rule above. **C DO LATER**: C is a new backend, not a footprint change, and needs its own plan.
The `onnxruntime-common` pin goes away only with B.

### 3.6 better-sqlite3 to `node:sqlite`

**Saving.** 27.7 MB and 2 packages. The repair machinery goes away too:

- `scripts/rebuild-native.mjs` (the repo `postinstall`);
- the rebuild branch of `cli/ensure-deps.js` and the binding check of `src/deps-health.ts`;
- the structural gate on the prebuilds path in a sync task script outside this repo;
- `@types/better-sqlite3`, `trustedDependencies` and `allowScripts` in `package.json`.

**API gaps.**

| Item | better-sqlite3 | `node:sqlite` | Sites |
|---|---|---|---|
| Transactions | `db.transaction(fn)` returns a callable | no helper | 12 |
| Pragmas | `db.pragma(...)`, write and read forms | no helper; use `exec` and `prepare` | 12 |
| Constructor options | `{ readonly, fileMustExist }` | `{ readOnly, open }` | see below |
| Types | `import type Database` | own types | 25 files |
| `exec`, `prepare`, `close` | present | present | |

No `function`, `aggregate`, `backup`, `serialize`, `iterate`, `pluck` or `raw` call appears in source.

**Transaction wrapper.** `src/learn/knowledge-store.ts` calls `this.db.transaction(fn).immediate()`. Other sites call the returned function with arguments (`src/embedding-migration.ts`, `src/learn/learning-db.ts`). The wrapper supports these behaviours:

- the default mode and `immediate` (`BEGIN IMMEDIATE`);
- nested calls as `SAVEPOINT`;
- rollback on a throw;
- the return of the callback value;
- argument passing to the callback.

`BEGIN IMMEDIATE` takes the write lock at the start. A plain `BEGIN` lets a second writer act between the read and the update.
Test: two processes open one file. The second process blocks in `BEGIN IMMEDIATE` until the first commits. The test fails if the wrapper uses a plain `BEGIN`.

**Pragma wrapper.** `src/db.ts` uses the read form `pragma('busy_timeout')` once. The other 11 sites use the write form. The read form returns an array in better-sqlite3 and one row in `node:sqlite`. The wrapper returns what each call site expects.

**Constructor sites.**

- `{ readonly: true, fileMustExist: true }`: `src/db.ts`, `src/learn/knowledge-store.ts`, `src/doctor-learn.ts` (first open).
- `{ readonly: true }` alone: `src/learn/learning-store.ts`, `src/stats.ts`, `src/doctor-learn.ts` (second open).

**Read-only open of a missing file.** On Node 26.13, `new DatabaseSync(missing, { readOnly: true })` throws "unable to open database file" and creates no file. The port keeps the throw and adds no existence pre-check, because a pre-check adds a race. A test opens a missing path read-only and expects the error.

**Result shape** (measured on Node 26.13 only; the PR repeats the checks on 22.16.0 and 24.x):

- Rows have a null prototype. A test that uses `toEqual` against a plain object, and code that calls `row.hasOwnProperty`, need a check.
- An integer above 2^53 throws ("Value is too large to be represented as a JavaScript number"). better-sqlite3 returns a rounded number. The PR checks the schema with a query for columns that can hold such a value.

**Node floor.** The version facts in this section come from the Node documentation. The plan does not measure these facts here. The PR checks each fact against the real binaries and corrects this document if one differs.

- `node:sqlite` loads unflagged from Node 22.13.0.
- `loadExtension` and `enableLoadExtension` exist from 22.13.0.
- The `timeout` (busy timeout) option exists from 22.16.0 and from 24.0.0.
- The documentation gives no version for the `allowExtension` constructor option.
- Stability is 1.1 (active development) on the 22 line, and 1.2 (release candidate) from 24.15.0.
- The `defensive` option exists from 24.12.0 and is on by default from 24.14.0.

**Floor decision.** The floor becomes 22.16.0, the lowest 22.x release with the `timeout` option.

- The PR sets `engines.node`, `NODE_FLOOR` in `src/node-floor.ts`, `CLAUDE.md` and the architecture docs to 22.16.0.
- The change breaks hosts on Node 22.0.0 to 22.15.x. The CHANGELOG entry states the break.
- The change is a fork-only divergence. The PR records the divergence in `docs/roadmap/upstream-sync.md`.
- A 24.x floor drops the 22 line. The decision keeps the 22 line, because 22.16.0 raises the floor by the smallest amount.

**sqlite-vec.** Open with `allowExtension: true`. Then call `loadExtension(getLoadablePath())`. The test runs with `defensive` on.
On Node 26.13 with sqlite-vec 0.1.9, `SELECT vec_version()` returns `v0.1.9`, and a `vec0` KNN `MATCH` query returns a row with zero bytes on stderr. That measurement proves nothing for 22.x or 24.x.

**WAL and busy timeout.** Use the `timeout` option with the 5000 ms default of `EPISODIC_MEMORY_DB_BUSY_TIMEOUT_MS`. Use `PRAGMA busy_timeout` for any path that the option does not cover.

**stderr.** A 22.x binary can print an `ExperimentalWarning` on stderr. `test/mcp-protocol.test.ts` checks stderr with `toContain`, so a warning does not break the test. The PR records the warning text from a real 22.16.0 binary.

**Risk.** The API gaps, the stability tier on the 22 line, and changes in query timing. The repair code removal also removes a recovery path. `episodic-memory doctor` must still report a broken native layer if a later dependency has one.

**Acceptance test.**

1. Indexing the fixture corpus gives the same row counts before and after.
2. Measure the median search latency on the same host, before and after. The median after is at most 10% slower (chosen threshold). The PR fixes the run count and the corpus.
3. The CI matrix runs the exact floor binary (Node 22.16.0) and the latest Node 24.x. Each job runs the full suite.
4. On Node 22.16.0, `allowExtension`, `loadExtension`, `timeout`, `readOnly` and `open` all work.
5. The two-process `BEGIN IMMEDIATE` test passes on each binary.
6. `episodic-memory doctor` reports a healthy tree on each binary.

**Rollback.** Section 8. The revert restores `engines` and `src/node-floor.ts`.

**Verdict: DO LATER.** The main benefit is the removal of the native-build path. The PR waits for the Node 22.16.0 CI job, the stderr text check and the performance check.

### 3.7 KEEP list

| Dependency | Size (MB) | Reason |
|---|---|---|
| `@modelcontextprotocol/server` | 7.6 exclusive | The MCP server (`src/mcp-server.ts`). The closure is 3 packages. |
| `zod` | 0.0 exclusive (6.1 own) | The MCP server and 2 source files use `zod`. The Agent SDK declares `zod` as a peer. |
| `marked` | 0.4 | One import in `src/show.ts`. The package ships its own types. |
| `sqlite-vec` | 0.3 exclusive | The only vector index. The `vec0` extension loads from an optional platform package, so no step uses `--omit=optional`. |
| `@huggingface/transformers` (after section 3.3) | 128.8 (estimate) | The embedding pipeline that the code runs. Option B is the only step that removes `@huggingface/transformers`. |
| `@anthropic-ai/claude-agent-sdk` | 5.2 without the platform package (estimate) | Three import sites. The plan can remove only the platform package (section 3.4). |
| `better-sqlite3` | 27.7 | The database layer until section 3.6 lands. |
| `onnxruntime-common` | 0.0 | Hoist pin: transformers imports `onnxruntime-common` without a declaration. KEEP until option B removes the pin. |

Remove list:

- `tsx` and `@types/marked` (section 3.1);
- the devDependencies on plugin hosts (section 3.2);
- `onnxruntime-web`, through the stub (section 3.3a);
- the idle `onnxruntime-node` binaries (section 3.3b).

### 3.8 Major dependency bumps

This plan owns the dependency list. Each cross-major bump has its own decision.

| Bump | Saving | Verdict | Reason |
|---|---|---|---|
| `typescript` 5 to 6 | 0 (devDependency; off plugin hosts after section 3.2) | **DO LATER** | A compiler change alters `dist/`. The bump needs its own PR, a build check and a line-by-line read of the `dist/` diff. |
| `marked` 16 to 18 | 0 | **DO LATER** | No size saving. One import site. The bump needs its own PR and an output check of `src/show.ts`. |
| `@types/node` 24 to 25 | 0 | **KEEP at 24** | The types follow the runtime floor and the CI Node version. Decide after section 3.6 sets the floor. |

The removal of `@types/marked` in section 3.1 uses the types that `marked` 16 ships. That removal is not a major bump.

## 4. Savings summary

| Item | Verdict | Saving (MB) | Packages | Basis |
|---|---|---|---|---|
| 3.1 quick wins | DO | 12.4 on a plugin host; 0 on a repo checkout | 4 | reachability |
| 3.2 `--omit=dev` | DO | 78.4 on a plugin host (includes 3.1) | 54 | reachability; estimate until installed |
| 3.3a `onnxruntime-web` stub | DO | 140.7 | 18 | install cache at the `bun.lock` versions; 151.9 MB on an npm host |
| 3.3b idle ORT binaries | DO | 158.1 on Windows x64 | 0 | measured directory sizes; estimate until pruned |
| 3.4 SDK platform package | DO (opt-in) | 269.2 on opt-in hosts; 0 by default | 1 | measured package size |
| 3.5 option B | DO LATER | 65.5 | 6 | reachability; estimate |
| 3.6 `node:sqlite` | DO LATER | 27.7 | 2 | measured closure |

DO items on a default Windows x64 plugin host: 78.4 + 140.7 + 158.1 = 377.2 MB (estimate). The 12.4 MB of section 3.1 is inside the 78.4 MB.
Resulting total: 839.2 - 377.2 = 462.0 MB (estimate). An opt-in host also saves 269.2 MB, for 192.8 MB (estimate).

## 5. Required checks for every PR

Every PR of section 6 passes each check. The PR body records each result.

CI job steps, in the order of `.github/workflows/ci.yml`:

1. `bun install --frozen-lockfile` with the pinned Bun version.
2. `bun audit --audit-level=critical`.
3. `bun run --if-present typecheck`.
4. `bun run --if-present lint`. `package.json` has no `lint` script, so the step does nothing.
5. `bun run --if-present test` (`vitest run`).
6. `bun run --if-present build`.
7. `git diff --ignore-cr-at-eol --stat --exit-code -- dist`.
8. `repo-tools check . --docs=docs/architecture` (architecture-docs gate).
9. `repo-tools docs check .` (code-docs gate).
10. Node runtime smoke: `import('./dist/index.js')`. A throw, a syntax error or an unresolved import fails the job.

Test count rule:

- The test count of the PR equals the count of the base commit plus the tests that the PR adds.
- Read the base count from the CI log of the base commit.
- A lower count fails the PR.

Additional checks:

- The preparing agent runs `vitest run` on a Windows host. The list of failing tests must equal the list of the base commit on the same host.
- Section 3.6 adds the Node 22.16.0 CI job.
- The PR body states the test counts, the output of both `repo-tools` gates, and the size before and after.

## 6. PR sequence

Each PR changes `package.json`, `bun.lock`, the rebuilt `dist/`, the source, the architecture-doc refresh and `CHANGELOG.md` under `[Unreleased]`, as its step needs.
Each PR regenerates `bun.lock` from its own parent commit. Each PR reverts on its own.

| Order | PR | Section | Verdict | Expected saving (estimate) |
|---|---|---|---|---|
| 1 | Quick wins | 3.1 | DO | 12.4 MB on a plugin host |
| 2 | `--omit=dev` on plugin hosts | 3.2 | DO | 78.4 MB on a plugin host (includes PR 1) |
| 3 | `onnxruntime-web` stub override | 3.3a | DO | 140.7 MB (measured) |
| 4 | Prune idle `onnxruntime-node` binaries | 3.3b | DO | 158.1 MB on Windows x64 |
| 5 | SDK platform package, opt-in | 3.4 | DO | 269.2 MB on opt-in hosts; 0 by default |
| 6 | Embedding option B, with parity gate | 3.5 | DO LATER | 65.5 MB |
| 7 | better-sqlite3 to `node:sqlite` | 3.6 | DO LATER | 27.7 MB |

Order reasons:

- PR 1 has the lowest risk.
- PR 2 is one flag. PR 2 lands before the PRs that edit `cli/ensure-deps.js` for other reasons.
- PR 3 changes no source code.
- PR 4 builds the best-effort helper that PR 5 uses.
- PRs 6 and 7 wait for their named conditions.

Option C and the three bumps are not in the sequence. Each needs its own PR when its condition holds.

Size band: the expected saving, plus or minus 10% of that saving. The band is never narrower than 1 MB. The 10% tolerance is a chosen value.

## 7. Measurement method

Use this method for every before figure and every after figure.

1. Make an empty scratch directory outside the repo.
2. Extract the tracked files of the base commit into the directory, for example with `git archive <commit> | tar -x`.
   The tracked files hold `scripts/`, `cli/`, `dist/` and `vendor/`. The install, the root `postinstall` and the prune need these files. The repo does not track `node_modules`.
3. Record the platform, the architecture, `node -v` and `npm -v`.
4. Call `ensureDeps` once: `node -e "import('./cli/ensure-deps.js').then((m) => m.ensureDeps(process.cwd()))"`. Record the exit status.
   The call runs the plugin-host install with its flags, then the prune of PRs 4 and 5. Do not judge success from the output text.
   For the opt-in figure of PR 5, set `EPISODIC_MEMORY_CLAUDE_BIN` in the environment of this step.
5. Record `npm ls --all --parseable`.
6. Walk the tree with the rules below. Record the `node_modules` total, the top-level entry count (dot entries excluded) and the per-row table of section 1.
7. Build the after tree in a second scratch directory from the PR commit. Use the same npm cache. Build the two trees back to back. Repeat steps 2 to 6.
8. Compare the two `npm ls` records. Explain each version difference before you compare sizes.
9. Check each removed directory by its exact name, for example `test ! -d node_modules/<exact-name>`. A directory that is present fails the PR.
10. Repeat steps 1 to 9 with `bun install --frozen-lockfile`, the CI installer, in place of step 4. Record both results.

Walk rules:

- A package is a directory that holds a `package.json`.
- Resolve each dependency with Node resolution from the dependent directory: nested `node_modules` first, then each parent.
- Follow `dependencies` and `optionalDependencies`. Do not follow peers or symbolic links.
- The size of a package is the sum of its regular files outside its own `node_modules`.
- Each package counts once.
- Exclusive means reachable from one direct dependency only.

The walk is a short script in the scratch directory. The script never writes to the tree under measurement. This plan adds no CI size gate. CI runs Linux, and the figures of this plan are Windows figures.

Fixture search: build a fixture index once with the base commit. Set `EPISODIC_MEMORY_DB_PATH` to a scratch file. Index the 50-passage parity corpus. Commit nothing.
Each PR runs `node cli/episodic-memory.js search --vector <query>` against a copy of that file. The known passage must be the first hit. The check also proves a vector of 384 dimensions.

## 8. Rollback

Each PR reverts with the same steps:

1. Revert the merge commit on a new branch. Open a pull request. Use `git revert -m 1 <merge-commit>` for a merge commit. A squash merge reverts with one commit.
2. Run `bun run build`. Commit the rebuilt `dist/`.
3. Bump `version` in `.claude-plugin/marketplace.json` (the plugin entry) and in `.claude-plugin/plugin.json`. The two values must match. The updater reads `plugin.json`.
4. Run `claude plugin marketplace update local-marketplace`.
5. Run `claude plugin update episodic-memory@local-marketplace`.
6. Run the checks of section 5 on the reverted tree.

The preparing agent runs steps 1, 2 and 6. The release owner runs steps 3 to 5.

Special cases:

- PR 3: the revert removes the override and the stub. Run `bun install` to regenerate `bun.lock`.
- PRs 4 and 5: `deps-health` treats the pruned tree as healthy, so no automatic reinstall happens. Run `npm install --no-audit --no-fund` in the plugin root.
- Option B with a passed parity gate: the old vectors stay valid. No index rollback runs.
- Option B with a bump, and option C: the old vectors stay under the old `EMBEDDING_VERSION`. A rollback restores the old version.

## 9. Ownership

- The preparing agent prepares each PR of section 6. The preparing agent runs the gates, records the evidence in the PR body and writes the CHANGELOG entry.
- The release owner bumps versions, tags, publishes releases and updates the plugin. Any PR whose merge is a release belongs to the release owner.
- No PR of this plan performs a release or a publish. The preparing agent stops at "ready to release".
