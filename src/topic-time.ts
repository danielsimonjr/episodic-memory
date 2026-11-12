/**
 * Time and unit id rules of the topic memory. The module imports nothing, so the MCP schema
 * can use the rules without loading the document parser.
 */

/** The form of a unit identifier: eight lowercase hex characters. */
export const UNIT_ID_PATTERN = /^[0-9a-f]{8}$/;

/**
 * Tell whether a time is a real `YYYY`, `YYYY-MM` or `YYYY-MM-DD`.
 *
 * The day check uses the Gregorian leap rule for every year, the years 0000 to 0099 included.
 *
 * @param time the time text
 */
export function isValidTime(time: string): boolean {
  const m = /^(\d{4})(?:-(\d{2})(?:-(\d{2}))?)?$/.exec(time);
  if (!m) return false;
  if (m[2] === undefined) return true;
  const month = Number(m[2]);
  if (month < 1 || month > 12) return false;
  if (m[3] === undefined) return true;
  const year = Number(m[1]);
  const leap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const lastDay = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
  const day = Number(m[3]);
  return day >= 1 && day <= lastDay;
}

/** The start of the interval that a time covers. */
export function startOf(time: string): string {
  if (time.length === 4) return `${time}-01-01`;
  if (time.length === 7) return `${time}-01`;
  return time;
}

/** The end of the interval that a time covers. */
export function endOf(time: string): string {
  if (time.length === 4) return `${time}-12-31`;
  if (time.length === 7) return `${time}-31`;
  return time;
}
