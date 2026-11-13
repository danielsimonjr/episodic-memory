/**
 * Markdown to HTML renderer for the transcript viewer. Node built-ins only.
 * Every block and inline rule is a line or token scan. No regex has nested
 * quantifiers over unbounded input.
 */
const HTML_ESCAPES = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;',
};
/** Escape the five HTML-special characters of a text or attribute value. */
export function escapeHtml(text) {
    return text.replace(/[&<>"']/g, (ch) => HTML_ESCAPES[ch]);
}
const ENTITY_IN_FIRST_SEGMENT = /^[^/?]*&#?[A-Za-z0-9]+;/;
const ALLOWED_SCHEMES = new Set(['http', 'https', 'mailto']);
const TRAILING_PUNCT = ".,:;!?*_~'\"";
const ASCII_PUNCT = /^[!-/:-@[-`{-~]$/;
/**
 * Return the URL text that goes into an href, or null when a browser could load a scheme
 * other than http, https or mailto. The caller escapes the result once, so the browser sees
 * this exact string. The check removes control characters and whitespace (a superset of what
 * a browser strips) before it reads the scheme. `&amp;` is decoded once, as CommonMark does.
 */
function safeUrl(raw) {
    const href = raw.replace(/&amp;/g, '&');
    const cleaned = href.replace(/[\u0000- \u007f\s]/g, '');
    const sep = cleaned.search(/[/?#]/);
    const head = sep < 0 ? cleaned : cleaned.slice(0, sep);
    const colon = head.indexOf(':');
    if (colon >= 0 && !ALLOWED_SCHEMES.has(head.slice(0, colon).toLowerCase())) {
        return null;
    }
    // An entity before the first `/` or `?` is where a scheme hides. No real relative path holds one.
    return ENTITY_IN_FIRST_SEGMENT.test(cleaned) ? null : href;
}
function makeToken(kind, value) {
    return {
        kind,
        value,
        ch: '',
        count: 0,
        canOpen: false,
        canClose: false,
        done: false,
        openTags: [],
        closeTags: [],
    };
}
function at(src, index) {
    return index >= 0 && index < src.length ? src[index] : undefined;
}
/** Append plain text. Adjacent text joins one token. */
function pushText(scan, value) {
    if (value === '') {
        return;
    }
    const last = scan.tokens[scan.tokens.length - 1];
    if (last !== undefined && last.kind === 'text') {
        last.value += value;
        return;
    }
    scan.tokens.push(makeToken('text', value));
}
function pushHtml(scan, value) {
    scan.tokens.push(makeToken('html', value));
}
const SPECIAL_CHARS = new Set(['\\', '`', '[', ']', '*', '_', '\n', 'h', 'H']);
/** Scan the inline text of one block, left to right. The first rule that matches wins. */
function scanInline(src) {
    const scan = { src, tokens: [], brackets: [], runs: undefined, tailBudget: 4 * src.length + 1024 };
    let i = 0;
    while (i < src.length) {
        i = SPECIAL_CHARS.has(src[i]) ? scanSpecial(scan, i) : scanPlain(scan, i);
    }
    return scan.tokens;
}
function scanPlain(scan, start) {
    let end = start;
    while (end < scan.src.length && !SPECIAL_CHARS.has(scan.src[end])) {
        end += 1;
    }
    pushText(scan, scan.src.slice(start, end));
    return end;
}
function scanSpecial(scan, i) {
    switch (scan.src[i]) {
        case '\\':
            return scanEscape(scan, i);
        case '`':
            return scanCodeSpan(scan, i);
        case '[':
            return scanOpen(scan, i);
        case ']':
            return scanClose(scan, i);
        case '*':
        case '_':
            return scanDelimRun(scan, i);
        case '\n':
            return scanNewline(scan, i);
        case 'h':
        case 'H':
            return scanAutolink(scan, i);
        default:
            pushText(scan, scan.src[i]);
            return i + 1;
    }
}
/** A backslash before ASCII punctuation is a literal character. Before a newline it is a hard break. */
function scanEscape(scan, i) {
    const next = at(scan.src, i + 1);
    if (next === undefined) {
        pushText(scan, '\\');
        return i + 1;
    }
    if (next === '\n') {
        pushHtml(scan, '<br>');
        return i + 2;
    }
    if (ASCII_PUNCT.test(next)) {
        pushText(scan, next);
        return i + 2;
    }
    pushText(scan, '\\');
    return i + 1;
}
/** Two or more spaces before a newline make a hard break. Other newlines stay text. */
function scanNewline(scan, i) {
    let spaces = 0;
    while (at(scan.src, i - 1 - spaces) === ' ') {
        spaces += 1;
    }
    const last = scan.tokens[scan.tokens.length - 1];
    if (spaces >= 2 && last !== undefined && last.kind === 'text' && last.value.length >= spaces) {
        last.value = last.value.slice(0, last.value.length - spaces);
        pushHtml(scan, '<br>');
    }
    else {
        pushText(scan, '\n');
    }
    return i + 1;
}
/** Index the start of every maximal backtick run by its width, in one pass. */
function indexBacktickRuns(src) {
    const runs = new Map();
    let i = src.indexOf('`');
    while (i >= 0) {
        let end = i;
        while (src[end] === '`') {
            end += 1;
        }
        const starts = runs.get(end - i);
        if (starts === undefined) {
            runs.set(end - i, [i]);
        }
        else {
            starts.push(i);
        }
        i = src.indexOf('`', end);
    }
    return runs;
}
/** Return the start of the first backtick run of exactly `width` at or after `from`, or -1. */
function findBacktickRun(scan, from, width) {
    scan.runs ??= indexBacktickRuns(scan.src);
    const starts = scan.runs.get(width);
    if (starts === undefined) {
        return -1;
    }
    let lo = 0;
    let hi = starts.length;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (starts[mid] < from) {
            lo = mid + 1;
        }
        else {
            hi = mid;
        }
    }
    return lo < starts.length ? starts[lo] : -1;
}
/** Strip one space from each end when both ends hold a space and the content is not all spaces. */
function codeContent(content) {
    const padded = content.length >= 2 && content.startsWith(' ') && content.endsWith(' ');
    return padded && /[^ ]/.test(content) ? content.slice(1, -1) : content;
}
/** A backtick run opens a code span when a run of the same width closes it. Otherwise it is text. */
function scanCodeSpan(scan, i) {
    const src = scan.src;
    let open = i;
    while (src[open] === '`') {
        open += 1;
    }
    const width = open - i;
    const close = findBacktickRun(scan, open, width);
    if (close < 0) {
        pushText(scan, '`'.repeat(width));
        return open;
    }
    pushHtml(scan, `<code>${escapeHtml(codeContent(src.slice(open, close)))}</code>`);
    return close + width;
}
const LINK_SPACE = /[ \t\n\r\f\v]/;
/** Take `steps` from the tail budget. False when the budget is spent. */
function spend(scan, steps) {
    scan.tailBudget -= steps;
    return scan.tailBudget >= 0;
}
function skipLinkSpace(src, from) {
    let p = from;
    while (p < src.length && LINK_SPACE.test(src[p])) {
        p += 1;
    }
    return p;
}
/** Scan a bare destination: no whitespace, balanced parentheses. */
function scanBareDest(scan, from) {
    const src = scan.src;
    let depth = 0;
    let p = from;
    while (p < src.length && p - from <= scan.tailBudget) {
        const c = src[p];
        if (LINK_SPACE.test(c)) {
            break;
        }
        if (c === '(') {
            depth += 1;
        }
        else if (c === ')') {
            if (depth === 0) {
                break;
            }
            depth -= 1;
        }
        p += 1;
    }
    if (!spend(scan, p - from) || depth !== 0) {
        return null;
    }
    return { text: src.slice(from, p), end: p };
}
/** Scan an angle destination `<...>`. It holds no newline and no `<`. */
function scanAngleDest(scan, from) {
    const src = scan.src;
    let p = from + 1;
    while (p < src.length && p - from <= scan.tailBudget) {
        const c = src[p];
        if (c === '>') {
            return spend(scan, p - from) ? { text: src.slice(from + 1, p), end: p + 1 } : null;
        }
        if (c === '\n' || c === '<') {
            break;
        }
        p += 1;
    }
    spend(scan, p - from);
    return null;
}
/** Scan a quoted title. A backslash skips the next character. */
function scanTitle(scan, from) {
    const src = scan.src;
    const close = src[from] === '(' ? ')' : src[from];
    let p = from + 1;
    while (p < src.length && p - from <= scan.tailBudget) {
        const c = src[p];
        if (c === '\\') {
            p += 2;
            continue;
        }
        if (c === close) {
            return spend(scan, p - from) ? { text: src.slice(from + 1, p), end: p + 1 } : null;
        }
        p += 1;
    }
    spend(scan, p - from);
    return null;
}
/** Remove a backslash before each ASCII punctuation character. */
function unescapeMarkdown(text) {
    return text.replace(/\\([!-/:-@[-`{-~])/g, '$1');
}
/** Parse the `(destination "title")` tail that follows a closing bracket. */
function parseLinkTail(scan, from) {
    const src = scan.src;
    if (src[from] !== '(' || scan.tailBudget < 0) {
        return null;
    }
    const start = skipLinkSpace(src, from + 1);
    const dest = src[start] === '<' ? scanAngleDest(scan, start) : scanBareDest(scan, start);
    if (dest === null) {
        return null;
    }
    let p = skipLinkSpace(src, dest.end);
    let title;
    if (p > dest.end && (src[p] === '"' || src[p] === "'" || src[p] === '(')) {
        const quoted = scanTitle(scan, p);
        if (quoted === null) {
            return null;
        }
        title = unescapeMarkdown(quoted.text);
        p = skipLinkSpace(src, quoted.end);
    }
    if (src[p] !== ')') {
        return null;
    }
    return { dest: unescapeMarkdown(dest.text), title, end: p + 1 };
}
function titleAttr(title) {
    return title === undefined ? '' : ` title="${escapeHtml(title)}"`;
}
/** A `[` is a literal opener until a `]` with a valid tail closes it. */
function scanOpen(scan, i) {
    scan.brackets.push(scan.tokens.length);
    scan.tokens.push(makeToken('open', '['));
    return i + 1;
}
function scanClose(scan, i) {
    const openIndex = scan.brackets.pop();
    const tail = openIndex === undefined ? null : parseLinkTail(scan, i + 1);
    if (openIndex === undefined || tail === null) {
        pushText(scan, ']');
        return i + 1;
    }
    closeLink(scan, openIndex, tail);
    return tail.end;
}
/**
 * A link forms. Emphasis inside the text resolves now. Every earlier `[` goes inert,
 * because a link may not contain a link. A denied URL keeps the text and drops the anchor.
 */
function closeLink(scan, openIndex, tail) {
    const toks = scan.tokens;
    const href = safeUrl(tail.dest);
    scan.brackets.length = 0;
    processEmphasis(toks, openIndex + 1);
    for (let k = openIndex + 1; k < toks.length; k += 1) {
        const t = toks[k];
        if (t.kind === 'delim') {
            t.done = true;
        }
        else if (t.kind === 'auto') {
            t.kind = 'text';
        }
    }
    const opener = toks[openIndex];
    opener.kind = 'html';
    opener.value = href === null ? '' : `<a href="${escapeHtml(href)}"${titleAttr(tail.title)}>`;
    pushHtml(scan, href === null ? '' : '</a>');
}
function isSpaceChar(ch) {
    return ch === undefined || /\s/.test(ch);
}
function isPunctChar(ch) {
    return ch !== undefined && /[\p{P}\p{S}]/u.test(ch);
}
function isAlnumChar(ch) {
    return ch !== undefined && /[A-Za-z0-9]/.test(ch);
}
/** A run of `*` or `_` becomes one delimiter token. Flanking rules decide whether it opens or closes. */
function scanDelimRun(scan, i) {
    const src = scan.src;
    const ch = src[i];
    let end = i;
    while (src[end] === ch) {
        end += 1;
    }
    const before = at(src, i - 1);
    const after = at(src, end);
    const leftFlanking = !isSpaceChar(after) && (!isPunctChar(after) || isSpaceChar(before) || isPunctChar(before));
    const rightFlanking = !isSpaceChar(before) && (!isPunctChar(before) || isSpaceChar(after) || isPunctChar(after));
    const token = makeToken('delim', '');
    token.ch = ch;
    token.count = end - i;
    if (ch === '*') {
        token.canOpen = leftFlanking;
        token.canClose = rightFlanking;
    }
    else {
        token.canOpen = leftFlanking && (!rightFlanking || isPunctChar(before));
        token.canClose = rightFlanking && (!leftFlanking || isPunctChar(after));
    }
    scan.tokens.push(token);
    return end;
}
/**
 * Pair emphasis delimiters from `bottom` to the end, with one stack per character.
 * Each delimiter is pushed once and popped once, so the pass is linear.
 */
function processEmphasis(toks, bottom) {
    const stars = [];
    const unders = [];
    for (let k = bottom; k < toks.length; k += 1) {
        const t = toks[k];
        if (t.kind !== 'delim' || t.done) {
            continue;
        }
        const stack = t.ch === '*' ? stars : unders;
        if (t.canClose) {
            const other = t.ch === '*' ? unders : stars;
            matchCloser(toks, stack, other, t);
        }
        if (t.canOpen && t.count > 0) {
            stack.push(k);
        }
    }
}
/** Match a closer with the nearest opener. Two characters make strong, one makes em. */
function matchCloser(toks, stack, other, closer) {
    while (closer.count > 0 && stack.length > 0) {
        const openerAt = stack[stack.length - 1];
        const opener = toks[openerAt];
        // An opener of the other kind inside this pair can no longer match: drop it so the tags nest.
        while (other.length > 0 && other[other.length - 1] > openerAt) {
            other.pop();
        }
        const use = closer.count >= 2 && opener.count >= 2 ? 2 : 1;
        opener.count -= use;
        closer.count -= use;
        opener.openTags.push(use === 2 ? '<strong>' : '<em>');
        closer.closeTags.push(use === 2 ? '</strong>' : '</em>');
        if (opener.count === 0) {
            stack.pop();
        }
    }
}
function renderDelim(t) {
    return t.closeTags.join('') + t.ch.repeat(t.count) + [...t.openTags].reverse().join('');
}
const AUTOLINK_STOP = /[\s<]/;
function schemeLength(src, i) {
    const head = src.slice(i, i + 8).toLowerCase();
    if (head.startsWith('https://')) {
        return 8;
    }
    return head.startsWith('http://') ? 7 : 0;
}
/**
 * End of a bare URL. It stops at whitespace or `<`. Trailing punctuation goes back to the text.
 * A trailing `)` stays only when it closes a `(` inside the URL.
 */
function bareUrlEnd(src, start) {
    let end = start;
    let opens = 0;
    let closes = 0;
    while (end < src.length && !AUTOLINK_STOP.test(src[end])) {
        if (src[end] === '(') {
            opens += 1;
        }
        else if (src[end] === ')') {
            closes += 1;
        }
        end += 1;
    }
    while (end > start) {
        const c = src[end - 1];
        if (c === ')' && closes > opens) {
            closes -= 1;
        }
        else if (!TRAILING_PUNCT.includes(c)) {
            break;
        }
        end -= 1;
    }
    return end;
}
/** A bare `http://` or `https://` URL. The scheme must be followed by at least one character. */
function scanAutolink(scan, i) {
    const src = scan.src;
    const len = schemeLength(src, i);
    if (len === 0 || isAlnumChar(at(src, i - 1))) {
        pushText(scan, src[i]);
        return i + 1;
    }
    const end = bareUrlEnd(src, i + len);
    if (end === i + len) {
        pushText(scan, src[i]);
        return i + 1;
    }
    scan.tokens.push(makeToken('auto', src.slice(i, end)));
    return end;
}
function renderAuto(url) {
    const href = safeUrl(url);
    return href === null ? escapeHtml(url) : `<a href="${escapeHtml(href)}">${escapeHtml(url)}</a>`;
}
function renderToken(t) {
    switch (t.kind) {
        case 'text':
            return escapeHtml(t.value);
        case 'auto':
            return renderAuto(t.value);
        case 'delim':
            return renderDelim(t);
        case 'open':
            return '[';
        default:
            return t.value;
    }
}
/** Render the inline text of one block to HTML. */
function renderInline(src) {
    const toks = scanInline(src);
    processEmphasis(toks, 0);
    return toks.map(renderToken).join('');
}
function isBlank(line) {
    return /^[ \t]*$/.test(line);
}
function trimEndSpaces(text) {
    let end = text.length;
    while (end > 0 && (text[end - 1] === ' ' || text[end - 1] === '\t')) {
        end -= 1;
    }
    return text.slice(0, end);
}
function stripLeading(line) {
    return line.replace(/^[ \t]+/, '');
}
/** Remove up to `count` leading spaces. A fence removes its own indent from each body line. */
function stripIndent(line, count) {
    let k = 0;
    while (k < count && line[k] === ' ') {
        k += 1;
    }
    return line.slice(k);
}
/** A fence opens with three or more backticks or tildes. A backtick fence cannot hold a backtick in its info. */
function parseFenceOpen(line) {
    const m = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (m === null) {
        return null;
    }
    const info = m[3];
    if (m[2][0] === '`' && info.includes('`')) {
        return null;
    }
    return { ch: m[2][0], width: m[2].length, indent: m[1].length, info };
}
function isFenceClose(line, fence) {
    const m = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
    return m !== null && m[1][0] === fence.ch && m[1].length >= fence.width;
}
/** The first word of the info string, reduced to the characters a class name may hold. */
function languageClass(info) {
    const word = (info.trim().split(/\s+/)[0] ?? '').replace(/[^A-Za-z0-9_+.#-]/g, '');
    return word === '' ? '' : ` class="language-${word}"`;
}
/** A fence body is escaped verbatim. An unterminated fence runs to the end of its lines. */
function renderFence(lines, i, fence) {
    let j = i + 1;
    let code = '';
    while (j < lines.length && !isFenceClose(lines[j], fence)) {
        code += `${escapeHtml(stripIndent(lines[j], fence.indent))}\n`;
        j += 1;
    }
    const next = j < lines.length ? j + 1 : j;
    return { html: `<pre><code${languageClass(fence.info)}>${code}</code></pre>\n`, next };
}
/** Remove a closing run of `#` only when a space or tab precedes it. */
function stripClosingHashes(text) {
    let end = text.length;
    while (end > 0 && text[end - 1] === '#') {
        end -= 1;
    }
    if (end === text.length) {
        return text;
    }
    if (end === 0 || text[end - 1] === ' ' || text[end - 1] === '\t') {
        return trimEndSpaces(text.slice(0, end));
    }
    return text;
}
/** An ATX heading: one to six `#`, then a space, a tab or the end of the line. */
function headingParts(line) {
    const m = /^ {0,3}(#{1,6})(?=[ \t]|$)/.exec(line);
    if (m === null) {
        return null;
    }
    const content = stripClosingHashes(trimEndSpaces(stripLeading(line.slice(m[0].length))));
    return { level: m[1].length, content };
}
function renderHeading(line) {
    const parts = headingParts(line);
    if (parts === null) {
        return null;
    }
    return `<h${parts.level}>${renderInline(parts.content)}</h${parts.level}>\n`;
}
/** A thematic break: three or more of one marker, with spaces allowed between them. */
function isThematicBreak(line) {
    let indent = 0;
    while (indent < line.length && line[indent] === ' ') {
        indent += 1;
    }
    if (indent > 3) {
        return false;
    }
    const marker = line[indent];
    if (marker !== '-' && marker !== '*' && marker !== '_') {
        return false;
    }
    let count = 0;
    for (const c of line.slice(indent)) {
        if (c === marker) {
            count += 1;
        }
        else if (c !== ' ' && c !== '\t') {
            return false;
        }
    }
    return count >= 3;
}
/** Containers nest at most this deep. Past the cap their text renders as a paragraph. */
const MAX_DEPTH = 8;
/** A leaf block: a fence, a heading or a break. A lazy line cannot continue it. */
function isLeafLine(line) {
    return parseFenceOpen(line) !== null || headingParts(line) !== null || isThematicBreak(line);
}
/** Lines that end a paragraph: leaf blocks, a quote, and a bullet or an ordered item that starts at 1. */
function interruptsParagraph(line, depth = 0) {
    if (isLeafLine(line)) {
        return true;
    }
    if (depth >= MAX_DEPTH) {
        return false;
    }
    if (/^ {0,3}>/.test(line)) {
        return true;
    }
    const marker = parseListMarker(line);
    return (marker !== null &&
        (!marker.ordered || marker.start === 1) &&
        line.slice(marker.width).trim() !== '');
}
/** A line continues a quote lazily when the quote holds paragraph text and the line starts no block. */
function isLazyLine(inner, line, fence) {
    const prev = inner[inner.length - 1];
    return (fence === null && prev !== undefined && !isBlank(prev) && !isLeafLine(prev) && !interruptsParagraph(line));
}
/** A quote holds the lines that start with `>` (one `>` and an optional space) plus lazy lines. */
function collectQuote(lines, i, depth) {
    const inner = [];
    let fence = null;
    let j = i;
    while (j < lines.length && !isBlank(lines[j])) {
        const m = /^ {0,3}> ?/.exec(lines[j]);
        if (m !== null) {
            inner.push(lines[j].slice(m[0].length));
        }
        else if (isLazyLine(inner, lines[j], fence)) {
            inner.push(lines[j]);
        }
        else {
            break;
        }
        fence = nextFence(fence, inner[inner.length - 1]);
        j += 1;
    }
    return { html: `<blockquote>\n${renderBlocks(inner, depth + 1, false)}</blockquote>\n`, next: j };
}
/** A list marker: `-`, `*` or `+`, or digits then `.` or `)`. The width is the content column. */
function parseListMarker(line) {
    const m = /^( {0,3})(?:([-*+])|([0-9]{1,9})([.)]))([ \t]+|$)/.exec(line);
    if (m === null) {
        return null;
    }
    const ordered = m[3] !== undefined;
    const markerWidth = ordered ? m[3].length + 1 : 1;
    return {
        ordered,
        start: ordered ? Number(m[3]) : 1,
        delim: ordered ? m[4] : m[2],
        width: m[1].length + markerWidth + Math.max(m[5].length, 1),
    };
}
/** Items of one list share a kind: the same bullet, or the same ordered delimiter. */
function listKind(marker) {
    return marker.ordered ? `o${marker.delim}` : `b${marker.delim}`;
}
function indentOf(line) {
    let k = 0;
    while (k < line.length && line[k] === ' ') {
        k += 1;
    }
    return k;
}
function nextFence(fence, line) {
    if (fence === null) {
        return parseFenceOpen(line);
    }
    return isFenceClose(line, fence) ? null : fence;
}
/**
 * Collect one item. Lines indented to the content column continue it, with that
 * indent removed. A non-indented paragraph line is lazy. A list marker or a block ends it.
 */
function collectItem(lines, start, marker) {
    const body = [];
    let fence = null;
    let innerBlank = false;
    let pendingBlank = false;
    let sawBlank = false;
    let prevText = false;
    let j = start;
    while (j < lines.length) {
        const line = lines[j];
        let text;
        if (j === start) {
            text = line.slice(marker.width);
        }
        else if (isBlank(line)) {
            pendingBlank = fence === null;
            sawBlank = true;
            body.push('');
            prevText = false;
            j += 1;
            continue;
        }
        else if (indentOf(line) >= marker.width) {
            text = stripIndent(line, marker.width);
        }
        else if (parseListMarker(line) === null && prevText && fence === null && !interruptsParagraph(line)) {
            text = stripLeading(line);
        }
        else {
            break;
        }
        if (pendingBlank) {
            innerBlank = true;
        }
        pendingBlank = false;
        body.push(text);
        fence = nextFence(fence, text);
        prevText = text !== '' && !isLeafLine(text);
        j += 1;
    }
    let end = body.length;
    while (end > 0 && body[end - 1] === '') {
        end -= 1;
    }
    return { body: body.slice(0, end), next: j, endedBlank: sawBlank && end < body.length, innerBlank };
}
/** Consecutive non-blank lines form one paragraph. Lines join with a newline. */
function collectParagraph(lines, i, depth, tight) {
    const parts = [stripLeading(lines[i])];
    let j = i + 1;
    while (j < lines.length &&
        !isBlank(lines[j]) &&
        !interruptsParagraph(lines[j], depth) &&
        tableAligns(lines, j) === null) {
        parts.push(stripLeading(lines[j]));
        j += 1;
    }
    const text = renderInline(trimEndSpaces(parts.join('\n')));
    return { html: tight ? text : `<p>${text}</p>\n`, next: j };
}
/** A list: consecutive items of one kind. The list is loose when a blank line separates its parts. */
function parseList(lines, i, depth, first) {
    const items = [];
    let marker = first;
    let j = i;
    for (;;) {
        const item = collectItem(lines, j, marker);
        items.push(item);
        j = item.next;
        const next = j < lines.length ? parseListMarker(lines[j]) : null;
        if (next === null || listKind(next) !== listKind(first)) {
            break;
        }
        marker = next;
    }
    const loose = items.some((it) => it.innerBlank) || items.slice(0, -1).some((it) => it.endedBlank);
    const open = first.ordered ? (first.start === 1 ? '<ol>' : `<ol start="${first.start}">`) : '<ul>';
    const close = first.ordered ? '</ol>' : '</ul>';
    let html = `${open}\n`;
    for (const it of items) {
        html += `<li>${renderBlocks(it.body, depth + 1, !loose)}</li>\n`;
    }
    return { html: `${html}${close}\n`, next: j };
}
/** Split a table row on unescaped pipes. A leading and a trailing pipe are optional. */
function splitRow(line) {
    let text = line.trim();
    if (text.startsWith('|')) {
        text = text.slice(1);
    }
    if (text.endsWith('|') && !text.endsWith('\\|')) {
        text = text.slice(0, -1);
    }
    const cells = [];
    let start = 0;
    for (let k = 0; k < text.length; k += 1) {
        if (text[k] === '\\' && text[k + 1] === '|') {
            k += 1;
        }
        else if (text[k] === '|') {
            cells.push(text.slice(start, k).trim());
            start = k + 1;
        }
    }
    cells.push(text.slice(start).trim());
    return cells;
}
function alignOf(cell) {
    const left = cell.startsWith(':');
    const right = cell.endsWith(':');
    if (left && right) {
        return 'center';
    }
    if (left) {
        return 'left';
    }
    return right ? 'right' : '';
}
/** The column alignments of a delimiter row, or null when a cell is not `:?-+:?`. */
function delimiterAligns(line) {
    if (!line.includes('|')) {
        return null;
    }
    const aligns = [];
    for (const cell of splitRow(line)) {
        if (!/^:?-+:?$/.test(cell)) {
            return null;
        }
        aligns.push(alignOf(cell));
    }
    return aligns;
}
/** A table starts with a header row that has a pipe, then a delimiter row with the same cell count. */
function tableAligns(lines, i) {
    if (!lines[i].includes('|') || i + 1 >= lines.length) {
        return null;
    }
    const aligns = delimiterAligns(lines[i + 1]);
    return aligns !== null && aligns.length === splitRow(lines[i]).length ? aligns : null;
}
/** Cells follow the column count. A missing cell is empty and an extra cell is dropped. */
function cellsHtml(cells, aligns, tag, pad) {
    let out = '';
    for (let k = 0; k < aligns.length; k += 1) {
        if (k >= cells.length) {
            pad.left -= 1;
            if (pad.left < 0) {
                break;
            }
        }
        const attr = aligns[k] === '' ? '' : ` align="${aligns[k]}"`;
        out += `<${tag}${attr}>${renderInline(cells[k] ?? '')}</${tag}>`;
    }
    return out;
}
/** Empty cells that pad short rows, per table. Past the budget a short row stays short, so a wide table of short rows cannot grow without bound. */
const MAX_PAD_CELLS = 10000;
/** A table: the header, then body rows while a line holds a pipe. */
function parseTable(lines, i, aligns) {
    let body = '';
    const pad = { left: MAX_PAD_CELLS };
    let j = i + 2;
    while (j < lines.length && lines[j].includes('|') && !isLeafLine(lines[j]) && !/^ {0,3}>/.test(lines[j])) {
        body += `<tr>${cellsHtml(splitRow(lines[j]), aligns, 'td', pad)}</tr>\n`;
        j += 1;
    }
    const head = `<thead>\n<tr>${cellsHtml(splitRow(lines[i]), aligns, 'th', pad)}</tr>\n</thead>\n`;
    const bodyHtml = body === '' ? '' : `<tbody>\n${body}</tbody>\n`;
    return { html: `<table>\n${head}${bodyHtml}</table>\n`, next: j };
}
/** Parse the block that starts at line `i`. Containers stop at the depth cap. */
function parseBlock(lines, i, depth, tight) {
    const line = lines[i];
    const fence = parseFenceOpen(line);
    if (fence !== null) {
        return renderFence(lines, i, fence);
    }
    const heading = renderHeading(line);
    if (heading !== null) {
        return { html: heading, next: i + 1 };
    }
    if (isThematicBreak(line)) {
        return { html: '<hr>\n', next: i + 1 };
    }
    if (depth < MAX_DEPTH) {
        if (/^ {0,3}>/.test(line)) {
            return collectQuote(lines, i, depth);
        }
        const marker = parseListMarker(line);
        if (marker !== null) {
            return parseList(lines, i, depth, marker);
        }
    }
    const aligns = tableAligns(lines, i);
    if (aligns !== null) {
        return parseTable(lines, i, aligns);
    }
    return collectParagraph(lines, i, depth, tight);
}
/** Render a list of lines as blocks. Blank lines separate blocks. A tight list omits `<p>`. */
function renderBlocks(lines, depth, tight) {
    let out = '';
    let i = 0;
    while (i < lines.length) {
        if (isBlank(lines[i])) {
            i += 1;
        }
        else {
            const block = parseBlock(lines, i, depth, tight);
            out += block.html;
            i = block.next;
        }
    }
    return out;
}
/**
 * Render Markdown text to HTML. The function escapes all raw HTML and refuses unsafe link schemes.
 * The function never throws. Each block ends with one newline.
 * Not supported: indented code, setext headings, images (a `!` then the link rule),
 * angle and email autolinks, www autolinks, strikethrough, raw HTML blocks and reference links.
 */
export function markdownToHtml(text) {
    return renderBlocks(text.replace(/\r\n?/g, '\n').split('\n'), 0, false);
}
