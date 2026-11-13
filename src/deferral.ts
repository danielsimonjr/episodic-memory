/**
 * The errors that defer model work instead of failing it.
 *
 * A deferral stops the summary, digest and topic loops. No attempt is counted against a conversation or a
 * session, so the queue is the same at the next run. Three conditions defer: another agent holds the shared GPU
 * (`GpuReservedError`), no usable Claude Code executable exists (`ClaudeBinError`), and the Claude Code login
 * fails (`ClaudeAuthError`). Every later call would fail the same way, so each loop stops at the first one.
 */

import { ClaudeBinError } from './claude-bin.js';
import { GpuReservedError } from './ollama-backend.js';

/**
 * The Claude Code login failed: an expired OAuth token, a revoked key, or another HTTP 401.
 *
 * The login is the same for every call. As a result, the error defers the work and counts no attempt.
 */
export class ClaudeAuthError extends Error {
  /** The one-line reason for the logs and the sync report. */
  readonly detail: string;

  constructor(detail: string) {
    super(detail);
    this.name = 'ClaudeAuthError';
    this.detail = detail;
  }
}

/**
 * Return true when an SDK status or error text shows a failed Claude Code login.
 *
 * The SDK can report the failure as `api_error_status` 401, or only in the result text or the error message.
 * The text match needs a login phrase or the `API Error: 401` form of Claude Code. A bare "401" in the text
 * is not enough: a false match would defer the whole queue at every run.
 *
 * @param status - The `api_error_status` of the SDK result, when the result has one.
 * @param text - The result text or the error message.
 */
export function isClaudeAuthFailure(status: number | null | undefined, text: string): boolean {
  if (status === 401) return true;
  const lower = text.toLowerCase();
  return (
    lower.includes('failed to authenticate') ||
    lower.includes('authentication_error') ||
    lower.includes('oauth access token') ||
    /\bapi error: 401\b/.test(lower)
  );
}

/**
 * Return the one-line reason of a deferral, or null when the error is an ordinary failure.
 *
 * @param error - Any thrown value.
 */
export function deferralDetail(error: unknown): string | null {
  if (error instanceof GpuReservedError || error instanceof ClaudeBinError || error instanceof ClaudeAuthError) {
    return error.detail;
  }
  return null;
}
