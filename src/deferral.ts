/**
 * The errors that defer model work instead of failing it.
 *
 * A deferral stops the summary, digest and topic loops. No attempt is counted against a conversation or a
 * session, so the queue is the same at the next run. Two conditions defer: another agent holds the shared GPU
 * (`GpuReservedError`), and no usable Claude Code executable exists (`ClaudeBinError`). Every later call would
 * fail the same way, so each loop stops at the first one.
 */

import { ClaudeBinError } from './claude-bin.js';
import { GpuReservedError } from './ollama-backend.js';

/**
 * Return the one-line reason of a deferral, or null when the error is an ordinary failure.
 *
 * @param error - Any thrown value.
 */
export function deferralDetail(error: unknown): string | null {
  if (error instanceof GpuReservedError || error instanceof ClaudeBinError) return error.detail;
  return null;
}
