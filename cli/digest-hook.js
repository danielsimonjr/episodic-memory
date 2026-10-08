#!/usr/bin/env node
/**
 * SessionStart hook: print the project digest as additional context.
 *
 * Fast path by design. It opens the database read-only and imports only better-sqlite3 plus two small
 * modules from dist/ (no embeddings, no sqlite-vec). It prints nothing and exits 0 when the feature flag
 * is off, when the summarizer guard is set, when the database or the digest table is missing, or when
 * anything fails: a session must never wait on, or break because of, its memory.
 */
import fs from 'fs';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

async function main() {
  if (process.env.EPISODIC_MEMORY_DIGEST !== '1') return;
  if (process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD === '1') return;

  let cwd = process.cwd();
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (typeof input.cwd === 'string' && input.cwd) cwd = input.cwd;
  } catch {
    // keep process.cwd()
  }

  const { getDbPath } = await import('../dist/paths.js');
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return;

  const { default: Database } = await import('better-sqlite3');
  const { buildDigestText, projectKeyFromCwd, digestMaxChars } = await import('../dist/digest-inject.js');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    const text = buildDigestText(db, projectKeyFromCwd(cwd), digestMaxChars());
    if (!text) return;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } })
    );
  } finally {
    db.close();
  }
}

main().catch(() => {}).finally(() => process.exit(0));
