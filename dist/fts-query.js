/**
 * Turn free text into an FTS5 query in which each word must match.
 *
 * The function keeps runs of letters, digits and underscores, quotes each run as an FTS5 phrase, and
 * joins the phrases with spaces (an implicit AND). Quoting stops FTS5 from reading a word as an operator
 * or a column filter. The function returns null when the text holds no word.
 *
 * @param query the text to search for
 */
export function toFtsQuery(query) {
    const terms = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
    if (terms.length === 0)
        return null;
    return terms.map(t => `"${t}"`).join(' ');
}
