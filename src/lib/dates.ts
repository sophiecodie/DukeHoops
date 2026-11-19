import type { Nullable } from "@/lib/types";

/**
 * Game dates are usually full UTC timestamps from ESPN ("2001-11-20T02:00Z"). Curated games whose tip time
 * is unknown store only the calendar day ("2001-11-21") and set `timeUnknown`. These helpers treat both
 * correctly; never format a date-only value with `new Date(d)` in ET, which shifts it to the previous day.
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;
const ET = "America/New_York";

export function isDateOnly(d: Nullable<string> | undefined): d is string {
  return !!d && DATE_ONLY.test(d);
}

/** Milliseconds for chronological sorting. A date-only game sorts at noon ET on its day. Null sorts first. */
export function gameSortValue(d: Nullable<string>): number {
  if (!d) return 0;
  return Date.parse(isDateOnly(d) ? `${d}T12:00:00-05:00` : d);
}

/** Compare two games by date (ascending). */
export const byGameDate = <T extends { date: Nullable<string> }>(a: T, b: T) => gameSortValue(a.date) - gameSortValue(b.date);

/** Calendar day in ET, e.g. "Nov 21". Date-only values are already a calendar day, so they're formatted as-is. */
export function formatGameDay(d: Nullable<string>, opts: Intl.DateTimeFormatOptions = { month: "short", day: "numeric" }): Nullable<string> {
  if (!d) return null;
  return isDateOnly(d)
    ? new Date(`${d}T12:00:00Z`).toLocaleDateString("en-US", { ...opts, timeZone: "UTC" })
    : new Date(d).toLocaleDateString("en-US", { ...opts, timeZone: ET });
}
