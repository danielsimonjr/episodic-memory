/**
 * The `episodic-memory model` subcommand: `fetch` downloads the embedding model, `status` reports its files.
 *
 * This module is a CLI entry point. The module can write to stdout. The MCP server never loads this module.
 */
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { EMBEDDING_MODEL, FETCH_COMMAND, FETCH_FAILED_MARKER, ensureModel, modelDir, modelState } from './embedding-model.js';
const USAGE = `episodic-memory model - Manage the embedding model files

USAGE:
  episodic-memory model fetch    Download the model files that are missing or changed
  episodic-memory model status   Show where the model files are and whether they are ready

The model folder is EPISODIC_MEMORY_MODEL_DIR when that variable is set.
EPISODIC_MEMORY_MODEL_OFFLINE=1 turns a download into a check.`;
/**
 * Run `model fetch`: clear the failed-download marker, then download the bad files.
 *
 * @returns the exit code. 0 when the folder is ready, 1 when a download fails.
 */
async function runFetch() {
    const dir = modelDir();
    rmSync(join(dir, FETCH_FAILED_MARKER), { force: true });
    try {
        await ensureModel({ download: true, dir });
    }
    catch (error) {
        console.error(`Error: ${error.message}`);
        return 1;
    }
    console.log(`Model ready: ${dir} (${EMBEDDING_MODEL.repo}@${EMBEDDING_MODEL.revision})`);
    return 0;
}
/**
 * Run `model status`: print the folder, the pinned identity, the file states and the failed-download marker.
 *
 * @returns the exit code. 0 when the folder is ready, 1 when a file is missing or changed.
 */
function runStatus() {
    const dir = modelDir();
    const state = modelState({ dir });
    console.log(`Model: ${EMBEDDING_MODEL.repo}@${EMBEDDING_MODEL.revision}`);
    console.log(`Folder: ${dir}`);
    console.log(`State: ${state.state}`);
    for (const path of state.bad)
        console.log(`  not ready: ${join(dir, path)}`);
    if (existsSync(join(dir, FETCH_FAILED_MARKER))) {
        console.log(`Last download failed. Run "${FETCH_COMMAND}" to retry now.`);
    }
    return state.state === 'ready' ? 0 : 1;
}
/**
 * Entry point of `episodic-memory model`. The function sets `process.exitCode` and does not exit.
 *
 * @param args the arguments after `model`
 */
export async function main(args) {
    const sub = args[0];
    if (sub === 'fetch') {
        process.exitCode = await runFetch();
    }
    else if (sub === 'status') {
        process.exitCode = runStatus();
    }
    else {
        console.log(USAGE);
        process.exitCode = sub === '--help' || sub === '-h' || sub === undefined ? 0 : 1;
    }
}
main(process.argv.slice(2)).catch(error => {
    console.error(`Error: ${error.message}`);
    process.exitCode = 1;
});
