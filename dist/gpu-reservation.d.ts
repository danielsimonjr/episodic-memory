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
export interface GpuReservation {
    /** The session or job that holds the GPU. "unknown" when the file could not be read. */
    holder: string;
    /** Free text from the holder: what it runs. */
    why?: string;
    /** ISO timestamp the reservation began. */
    since?: string;
    /** ISO timestamp the holder expects to finish. An estimate, not a guarantee. */
    expectedEnd?: string;
    /** Set when the file could not be read or parsed. The holder is then "unknown". */
    fault?: string;
}
export declare function reservationPath(): string;
/** The current reservation, or `null` when the GPU is free. */
export declare function readGpuReservation(): GpuReservation | null;
/**
 * A message that says who holds the GPU while it is reserved, or `null` when it is free.
 * When the file could not be read, the message also names the cause and the path, so a stale or
 * damaged file can be found.
 */
export declare function gpuReservationBlock(): string | null;
