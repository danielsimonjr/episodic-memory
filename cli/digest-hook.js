#!/usr/bin/env node
/**
 * SessionStart hook: print the project digest and the learned block as additional context.
 *
 * Fast path by design. It opens each database read-only and imports only better-sqlite3 plus a few small
 * modules from dist/ (no embeddings, no sqlite-vec, no knowledge store, no SDK). The digest and the learned block
 * are gated independently: the digest on EPISODIC_MEMORY_DIGEST, the learned block on EPISODIC_MEMORY_LEARN.
 * With the learned block empty the output is byte-identical to the digest-only hook. It prints nothing and
 * exits 0 when the summarizer guard is set, when neither part has content, or when anything fails: a
 * session must never wait on, or break because of, its memory.
 */
import fs from 'fs';
import path from 'path';

async function readStdin() {
  if (process.stdin.isTTY) return '';
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf-8');
}

/** The digest text for this project, or '' when the digest is off or has nothing to say. */
async function buildDigest(cwd) {
  if (process.env.EPISODIC_MEMORY_DIGEST !== '1') return '';

  const { getDbPath } = await import('../dist/paths.js');
  const dbPath = getDbPath();
  if (!fs.existsSync(dbPath)) return '';

  const { Database } = await import('../dist/sqlite.js');
  const { buildDigestText, projectKeyFromCwd, digestMaxChars } = await import('../dist/digest-inject.js');
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  try {
    return buildDigestText(db, projectKeyFromCwd(cwd), digestMaxChars());
  } finally {
    db.close();
  }
}

/**
 * The stored learned block for this project, or '' when learning is off or the trace database is absent.
 *
 * The function opens the database read-only and never migrates it.
 * The hook may run against a `learning.sqlite` from an older build.
 * DDL on a read-only handle would throw.
 * Its import graph (learn-inject → types, learned-text-screen, redact; the hook → learn-config) never opens the
 * knowledge store.
 */
async function buildLearned(cwd) {
  const { learnConfig, learnEnabled } = await import('../dist/learn/learn-config.js');
  if (!learnEnabled()) return '';

  const { openLearningDb } = await import('../dist/learn/learning-store.js');
  const { readLearnedBlockCapped } = await import('../dist/learn/learn-inject.js');
  const { projectKeyFromCwd } = await import('../dist/digest-inject.js');
  const { getSuperpowersDir } = await import('../dist/paths.js');

  // Deliberately not `getLearningDbPath()`: that helper ensures `learned/`, and a
  // session start with the flag on but no learning run yet must create nothing.
  const dbPath = path.join(getSuperpowersDir(), 'learned', 'learning.sqlite');
  if (!fs.existsSync(dbPath)) return '';

  const db = openLearningDb({ readonly: true, migrate: false, path: dbPath });
  try {
    return readLearnedBlockCapped(db, projectKeyFromCwd(cwd), learnConfig().maxChars);
  } finally {
    db.close();
  }
}

async function main() {
  if (process.env.EPISODIC_MEMORY_SUMMARIZER_GUARD === '1') return;

  let cwd = process.cwd();
  try {
    const input = JSON.parse((await readStdin()) || '{}');
    if (typeof input.cwd === 'string' && input.cwd) cwd = input.cwd;
  } catch {
    // keep process.cwd()
  }

  const digest = await buildDigest(cwd);
  const learned = await buildLearned(cwd);

  let additionalContext;
  if (!learned) additionalContext = digest;
  else if (!digest) additionalContext = learned;
  else additionalContext = digest.trimEnd() + '\n\n' + learned;

  if (!additionalContext) return;
  process.stdout.write(
    JSON.stringify({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext } })
  );
}

main().catch(() => {}).finally(() => process.exit(0));
