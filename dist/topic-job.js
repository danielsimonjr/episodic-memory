import { shouldSkipReentrantSync } from './reentrancy.js';
import { gpuReservationBlock } from './gpu-reservation.js';
import { summarizerBackend } from './ollama-backend.js';
import { deferralDetail } from './deferral.js';
import { callDigestModel, promptBudgetChars } from './summarizer.js';
import { QUIET_MS, isTrivial, sessionExchanges } from './digest-job.js';
import { TOPIC_DEFAULTS, envPositiveInt, topicsEnabled } from './constants.js';
import { parseTopicDoc } from './topic-format.js';
import { buildTopicPrompt, parseTopicAnswer, prepareTopicEdit } from './topic-prompts.js';
import { validateTopicEdit } from './topic-validate.js';
import { ensureTopicSchema, getTopicMeta, installTopicEdit, recordTopicFailedCall, setTopicMeta, setTopicSessionStatus, } from './topic-db.js';
/** Heading that opens the error list of a retry. */
const RETRY_HEAD = 'The previous answer failed these checks. Answer again with the complete corrected blocks.';
/** The limits of the topic memory. Each one is read at call time. */
function topicLimits() {
    return {
        maxSessions: envPositiveInt('EPISODIC_MEMORY_TOPICS_MAX_SESSIONS', TOPIC_DEFAULTS.maxSessions),
        maxTranscriptChars: envPositiveInt('EPISODIC_MEMORY_TOPICS_MAX_TRANSCRIPT_CHARS', TOPIC_DEFAULTS.maxTranscriptChars),
        maxDocsChars: envPositiveInt('EPISODIC_MEMORY_TOPICS_MAX_DOCS_CHARS', TOPIC_DEFAULTS.maxDocsChars),
        maxDocChars: envPositiveInt('EPISODIC_MEMORY_TOPICS_MAX_DOC_CHARS', TOPIC_DEFAULTS.maxDocChars),
        maxDocs: envPositiveInt('EPISODIC_MEMORY_TOPICS_MAX_DOCS', TOPIC_DEFAULTS.maxDocs),
    };
}
/**
 * Return the `since` time. The first run stores it. EPISODIC_MEMORY_TOPICS_SINCE replaces `now` on that run,
 * and an invalid value is ignored.
 */
function sinceTime(db, now) {
    const stored = getTopicMeta(db, 'since');
    if (stored !== null)
        return stored;
    const raw = process.env.EPISODIC_MEMORY_TOPICS_SINCE;
    const parsed = Date.parse(raw ?? '');
    if (raw !== undefined && raw !== '' && !Number.isFinite(parsed)) {
        console.error('topics: EPISODIC_MEMORY_TOPICS_SINCE is not a valid time, using now');
    }
    const value = new Date(Number.isFinite(parsed) ? parsed : now.getTime()).toISOString();
    setTopicMeta(db, 'since', value);
    return value;
}
/** The sessions that started at or after `since`, have no done or rejected row, and oldest first. */
function candidateSessions(db, since) {
    return db
        .prepare(`SELECT e.project AS project, e.session_id AS session_id, MIN(e.timestamp) AS start, MAX(e.timestamp) AS end
       FROM exchanges e
       WHERE e.session_id IS NOT NULL
         AND NOT EXISTS (
           SELECT 1 FROM topic_session t
           WHERE t.project = e.project AND t.session_id = e.session_id AND t.status IN ('done', 'rejected')
         )
       GROUP BY e.project, e.session_id
       HAVING MIN(e.timestamp) >= ?
       ORDER BY MIN(e.timestamp), e.project, e.session_id`)
        .all(since);
}
/** The stored documents of a project by slug, as the prompt needs them. buildTopicPrompt sorts them by update time. */
function storedDocs(db, project) {
    const rows = db
        .prepare('SELECT slug, text, updated_at FROM topic_doc WHERE project = ? ORDER BY slug')
        .all(project);
    return rows.map(row => {
        const doc = parseTopicDoc(row.slug, row.text);
        const headings = doc.outline.flatMap(item => (item.kind === 'heading' && item.level > 1 ? [item.name] : []));
        return { slug: row.slug, title: doc.title, headings, text: row.text, updatedAt: row.updated_at };
    });
}
function exchangeExists(db, project, id) {
    return db.prepare('SELECT 1 FROM exchanges WHERE project = ? AND id = ?').get(project, id) !== undefined;
}
function errorText(err) {
    return err instanceof Error ? err.message : String(err);
}
/**
 * Add the errors of the last answer to a prompt. The errors fill the room that the budget leaves, and each
 * error line is cut to that room.
 */
function withRetryErrors(prompt, errors, budget) {
    let text = `${prompt}\n${RETRY_HEAD}\n`;
    for (const error of errors) {
        const room = budget - text.length - 3; // room for "- " and the line end
        if (room <= 0)
            break;
        text += `- ${error.slice(0, room)}\n`;
    }
    return text;
}
/** Record a session as rejected, with the reason. */
function recordRejected(run, project, sessionId, reason) {
    console.error(`topics: session ${sessionId} rejected: ${reason}`);
    setTopicSessionStatus(run.db, project, sessionId, 'rejected', reason);
    run.result.rejected++;
}
/** Count one failed model call. The session is rejected on the last allowed failure. */
function recordFailedCall(run, project, sessionId, reason) {
    console.error(`topics: model call failed for session ${sessionId}: ${reason}`);
    run.result.failed++;
    const attempts = recordTopicFailedCall(run.db, project, sessionId, reason);
    if (attempts >= TOPIC_DEFAULTS.maxFailedCalls)
        recordRejected(run, project, sessionId, reason);
}
/**
 * Organize one session: build the prompt, ask the model, validate the answer and install it.
 *
 * A validation or parse error gets one retry with the error list. A session that no prompt can hold is
 * left as it is, with no row, so a later run with a larger budget can take it.
 */
async function organizeSession(run, limits, s, exchanges) {
    const { db, model, result } = run;
    const budget = promptBudgetChars();
    const docs = storedDocs(db, s.project);
    const before = new Map(docs.map(doc => [doc.slug, doc.text]));
    const built = buildTopicPrompt({
        exchanges,
        docs,
        maxTranscriptChars: limits.maxTranscriptChars,
        maxDocsChars: limits.maxDocsChars,
        // The retry adds its error list to the prompt, so the first prompt leaves room for it.
        budgetChars: budget - TOPIC_DEFAULTS.retryReserveChars,
    });
    if (built === null) {
        console.error(`topics: session ${s.session_id} skipped: no exchange fits the prompt budget`);
        return 'unfit';
    }
    let errors = [];
    for (let call = 1; call <= 2; call++) {
        const prompt = call === 1 ? built.prompt : withRetryErrors(built.prompt, errors, budget);
        let answer;
        try {
            answer = String((await model(prompt)) ?? '');
        }
        catch (err) {
            const deferred = deferralDetail(err);
            if (deferred !== null) {
                result.deferred = deferred;
                return 'stop';
            }
            recordFailedCall(run, s.project, s.session_id, errorText(err));
            return 'next';
        }
        try {
            const parsed = parseTopicAnswer(answer);
            if (parsed.errors.length > 0) {
                errors = parsed.errors;
                continue;
            }
            if (parsed.blocks.length === 0) {
                setTopicSessionStatus(db, s.project, s.session_id, 'done');
                result.empty++;
                return 'next';
            }
            const blocks = prepareTopicEdit({ project: s.project, blocks: parsed.blocks, marks: built.marks, before });
            errors = validateTopicEdit({
                before,
                blocks,
                shown: new Set(built.shown.keys()),
                exchangeExists: id => exchangeExists(db, s.project, id),
                limits: { maxDocChars: limits.maxDocChars, maxDocs: limits.maxDocs },
            });
            if (errors.length > 0)
                continue;
            const files = blocks.flatMap(block => (block.kind === 'file' ? [{ slug: block.slug, text: block.text }] : []));
            const deletes = blocks.flatMap(block => (block.kind === 'delete' ? [block.slug] : []));
            const outcome = installTopicEdit(db, s.project, { files, deletes, sessionId: s.session_id }, built.shown);
            if (outcome === 'stale') {
                result.stale++;
                return 'next';
            }
            result.installed++;
            return 'next';
        }
        catch (err) {
            // A fault in prepare, validate or install (a locked database, for one) can pass. Count it like a failed
            // model call: the session stays pending, and the next run tries it again, up to the failure limit.
            recordFailedCall(run, s.project, s.session_id, `edit failed: ${errorText(err)}`);
            return 'next';
        }
    }
    recordRejected(run, s.project, s.session_id, errors.join('\n'));
    return 'next';
}
/**
 * Run the topic job. It organizes the exchanges of finished sessions into the topic documents of their project.
 *
 * The function returns at once, and writes nothing, when EPISODIC_MEMORY_TOPICS is not `1`, or when the summarizer
 * guard is set. It stores `since` on the first run, before the GPU check. It stops early when another agent holds
 * the shared GPU, or at another deferral (`src/deferral.ts` lists the causes). It reports the reason in `deferred`.
 *
 * @param db the open index database
 * @param opts replaces the model call or the clock
 */
export async function runTopics(db, opts = {}) {
    const result = { installed: 0, empty: 0, rejected: 0, skipped: 0, stale: 0, failed: 0 };
    if (!topicsEnabled() || shouldSkipReentrantSync())
        return result;
    ensureTopicSchema(db);
    const now = opts.now ?? new Date();
    const since = sinceTime(db, now);
    // The default model call loads a model on the shared GPU. Wait while another agent holds it.
    if (!opts.model && summarizerBackend() === 'ollama') {
        const reserved = gpuReservationBlock();
        if (reserved) {
            console.error(`topics: skipped, ${reserved}`);
            result.deferred = reserved;
            return result;
        }
    }
    const run = { db, model: opts.model ?? callDigestModel, result };
    const limits = topicLimits();
    let attempted = 0;
    for (const s of candidateSessions(db, since)) {
        if (attempted >= limits.maxSessions)
            break;
        if (now.getTime() - new Date(s.end).getTime() < QUIET_MS) {
            result.skipped++;
            continue;
        }
        const exchanges = sessionExchanges(db, s.project, s.session_id);
        if (isTrivial(exchanges)) {
            result.skipped++;
            continue;
        }
        const outcome = await organizeSession(run, limits, s, exchanges);
        if (outcome === 'stop')
            break;
        if (outcome === 'unfit') {
            result.skipped++;
            continue;
        }
        attempted++;
    }
    return result;
}
