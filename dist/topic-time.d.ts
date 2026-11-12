/**
 * Time and unit id rules of the topic memory. The module imports nothing, so the MCP schema
 * can use the rules without loading the document parser.
 */
/** The form of a unit identifier: eight lowercase hex characters. */
export declare const UNIT_ID_PATTERN: RegExp;
/**
 * Tell whether a time is a real `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
 *
 * The day check uses the Gregorian leap rule for every year, the years 0000 to 0099 included.
 *
 * @param time the time text
 */
export declare function isValidTime(time: string): boolean;
/** The start of the interval that a time covers. */
export declare function startOf(time: string): string;
/** The end of the interval that a time covers. */
export declare function endOf(time: string): string;
