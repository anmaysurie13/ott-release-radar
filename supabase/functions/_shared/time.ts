// Asia/Kolkata time helpers. IST is a fixed UTC+05:30 (no DST), so plain offset math is exact.
export const IST_OFFSET_MS = 330 * 60 * 1000;
export const DAY_MS = 86_400_000;
/** Digest send time: Friday 18:30 IST = Friday 13:00 UTC. */
export const DIGEST_DOW = 5; // Friday
export const DIGEST_HOUR_IST = 18;
export const DIGEST_MINUTE_IST = 30;

export interface TimeWindow {
  start: Date; // inclusive
  end: Date;   // exclusive
  key: string; // IST date (YYYY-MM-DD) of `end` — one scheduled digest per key
}

/** YYYY-MM-DD of the instant as seen in IST. */
export function istDate(d: Date): string {
  return new Date(d.getTime() + IST_OFFSET_MS).toISOString().slice(0, 10);
}

/** The UTC instant of 00:00 IST on the given IST calendar date. */
export function istMidnight(ymd: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(ymd)) throw new Error(`bad date: ${ymd}`);
  return new Date(Date.parse(`${ymd}T00:00:00Z`) - IST_OFFSET_MS);
}

/** Most recent digest boundary (Fri 18:30 IST) at or before `now`. */
export function lastBoundary(now: Date): Date {
  const ist = new Date(now.getTime() + IST_OFFSET_MS); // shifted clock; read with getUTC*
  const daysBack = (ist.getUTCDay() - DIGEST_DOW + 7) % 7;
  const b = Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate() - daysBack,
    DIGEST_HOUR_IST, DIGEST_MINUTE_IST) - IST_OFFSET_MS;
  return new Date(b <= now.getTime() ? b : b - 7 * DAY_MS);
}

/** Next digest boundary strictly after `now`. */
export function nextBoundary(now: Date): Date {
  return new Date(lastBoundary(now).getTime() + 7 * DAY_MS);
}

/** Window delivered by the scheduled run at/after a boundary: [boundary-7d, boundary). */
export function digestWindowFor(now: Date): TimeWindow {
  const end = lastBoundary(now);
  return { start: new Date(end.getTime() - 7 * DAY_MS), end, key: istDate(end) };
}

/** The window currently accumulating (for previews / manual reruns mid-week). */
export function upcomingWindow(now: Date): TimeWindow {
  const end = nextBoundary(now);
  return { start: new Date(end.getTime() - 7 * DAY_MS), end, key: istDate(end) };
}

/** Rolling 7 days ending now (dashboard "New This Week"). */
export function rollingWindow(now: Date): TimeWindow {
  return { start: new Date(now.getTime() - 7 * DAY_MS), end: now, key: `rolling-${istDate(now)}` };
}

export function inWindow(t: Date, w: TimeWindow): boolean {
  return t.getTime() >= w.start.getTime() && t.getTime() < w.end.getTime();
}

/** A date-only availability (IST calendar date) is treated as 00:00 IST that day. */
export function dateInWindow(ymd: string, w: TimeWindow): boolean {
  return inWindow(istMidnight(ymd), w);
}

export function daysBetween(aYmd: string, bYmd: string): number {
  return Math.round((Date.parse(`${bYmd}T00:00:00Z`) - Date.parse(`${aYmd}T00:00:00Z`)) / DAY_MS);
}

export function formatIst(d: Date): string {
  const s = new Date(d.getTime() + IST_OFFSET_MS);
  const dd = s.toUTCString().slice(0, 11); // "Fri, 16 Oct"
  return `${dd} ${String(s.getUTCHours()).padStart(2, "0")}:${String(s.getUTCMinutes()).padStart(2, "0")} IST`;
}
