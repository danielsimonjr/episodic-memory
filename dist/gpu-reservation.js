/**
 * The fleet GPU reservation.
 *
 * One GPU serves every agent on the fleet. A benchmark that holds the GPU takes an exclusive
 * reservation by writing a JSON file. While the file names a holder, no other client may load a
 * model: a second model evicts the benchmark model or slows its decode, and the benchmark numbers
 * are worthless. The ollama summarizer backend loads a model, so it must check the file first.
 *
 * The rules match the other readers of the same file (the llm-wiki pipeline, the rlm skill, the
 * ollama-mcp tools):
 * - A missing file is FREE. The fleet releases the GPU by renaming the file.
 * - A file that parses but names no holder is FREE. It is stale or half written.
 * - A file that cannot be read, or is not valid JSON, is RESERVED. A false "reserved" skips one
 *   sync. A false "free" ruins the benchmark of another agent.
 * - The text `null` is not valid JSON for this purpose: it parses, and a reader that only looks for
 *   a holder would call it free. The other readers treat it as RESERVED, so this reader does too.
 *   A number, a string or an array also parses, has no holder, and stays FREE in every reader.
 * - An `expected_end` in the past is information, not an expiry. Only the holder releases.
 *
 * `FLEET_GPU_RESERVATION` overrides the path, so tests never read the real file.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
export function reservationPath() {
    return process.env.FLEET_GPU_RESERVATION || join(homedir(), 'Dropbox', '_fleet', 'gpu-reserved.json');
}
/** The current reservation, or `null` when the GPU is free. */
export function readGpuReservation() {
    let raw;
    try {
        raw = readFileSync(reservationPath(), 'utf8');
    }
    catch (err) {
        if (err.code === 'ENOENT')
            return null;
        return { holder: 'unknown', fault: `reservation file unreadable (${String(err)})` };
    }
    let data;
    try {
        data = JSON.parse(raw);
    }
    catch {
        return { holder: 'unknown', fault: 'reservation file is not valid JSON' };
    }
    if (data === null)
        return { holder: 'unknown', fault: 'reservation file is not valid JSON' };
    const holder = typeof data.holder === 'string' ? data.holder : '';
    if (!holder)
        return null;
    return {
        holder,
        why: typeof data.why === 'string' ? data.why : undefined,
        since: typeof data.since === 'string' ? data.since : undefined,
        expectedEnd: typeof data.expected_end === 'string' ? data.expected_end : undefined,
    };
}
/**
 * A message that says who holds the GPU while it is reserved, or `null` when it is free.
 * When the file could not be read, the message also names the cause and the path, so a stale or
 * damaged file can be found.
 */
export function gpuReservationBlock() {
    const held = readGpuReservation();
    if (held === null)
        return null;
    const fault = held.fault ? ` - ${held.fault}: ${reservationPath()}` : '';
    const until = held.expectedEnd ? `, expected free ${held.expectedEnd}` : '';
    return `fleet GPU reserved by ${held.holder}${fault}${until}`;
}
