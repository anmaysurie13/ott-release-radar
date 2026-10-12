import { describe, expect, it } from "vitest";
import {
  dateInWindow, digestWindowFor, formatIst, inWindow, istDate, istMidnight, lastBoundary, nextBoundary, rollingWindow, upcomingWindow,
} from "../supabase/functions/_shared/time.ts";

const utc = (s: string) => new Date(s);

describe("IST conversion", () => {
  it("Friday 13:00 UTC is Friday 18:30 IST", () => {
    expect(formatIst(utc("2026-10-16T13:00:00Z"))).toBe("Fri, 16 Oct 18:30 IST");
  });
  it("istDate rolls over at 18:30 UTC (IST midnight)", () => {
    expect(istDate(utc("2026-10-15T18:29:59Z"))).toBe("2026-10-15");
    expect(istDate(utc("2026-10-15T18:30:00Z"))).toBe("2026-10-16");
  });
  it("istMidnight is 18:30 UTC of the previous day", () => {
    expect(istMidnight("2026-10-16").toISOString()).toBe("2026-10-15T18:30:00.000Z");
  });
  it("rejects malformed dates", () => {
    expect(() => istMidnight("16-10-2026")).toThrow();
  });
});

describe("digest boundaries (Fri 18:30 IST)", () => {
  it("one second before the boundary belongs to the previous week", () => {
    expect(lastBoundary(utc("2026-10-16T12:59:59Z")).toISOString()).toBe("2026-10-09T13:00:00.000Z");
  });
  it("exactly at the boundary starts the new week", () => {
    expect(lastBoundary(utc("2026-10-16T13:00:00Z")).toISOString()).toBe("2026-10-16T13:00:00.000Z");
  });
  it("the scheduled run window is the 7 days before the boundary", () => {
    const w = digestWindowFor(utc("2026-10-16T13:00:05Z"));
    expect(w.start.toISOString()).toBe("2026-10-09T13:00:00.000Z");
    expect(w.end.toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(w.key).toBe("2026-10-16");
  });
  it("retries 15–60 minutes later map to the same window key (idempotency)", () => {
    expect(digestWindowFor(utc("2026-10-16T13:15:00Z")).key).toBe("2026-10-16");
    expect(digestWindowFor(utc("2026-10-16T14:00:00Z")).key).toBe("2026-10-16");
  });
  it("Thursday night IST (UTC Thursday) still maps to the previous Friday", () => {
    expect(digestWindowFor(utc("2026-10-15T20:00:00Z")).key).toBe("2026-10-09");
  });
  it("next boundary / upcoming window mid-week", () => {
    const now = utc("2026-10-12T06:00:00Z"); // Monday
    expect(nextBoundary(now).toISOString()).toBe("2026-10-16T13:00:00.000Z");
    expect(upcomingWindow(now).key).toBe("2026-10-16");
  });
  it("handles month/year rollover", () => {
    expect(digestWindowFor(utc("2027-01-01T13:30:00Z")).key).toBe("2027-01-01");
    expect(lastBoundary(utc("2026-12-31T10:00:00Z")).toISOString()).toBe("2026-12-25T13:00:00.000Z");
  });
});

describe("window inclusion", () => {
  const w = digestWindowFor(utc("2026-10-16T13:00:00Z"));
  it("start inclusive, end exclusive", () => {
    expect(inWindow(w.start, w)).toBe(true);
    expect(inWindow(w.end, w)).toBe(false);
    expect(inWindow(new Date(w.end.getTime() - 1), w)).toBe(true);
  });
  it("date-only availability counts from 00:00 IST", () => {
    expect(dateInWindow("2026-10-09", w)).toBe(false); // 00:00 IST Fri 9 Oct < 18:30 IST start → previous digest
    expect(dateInWindow("2026-10-10", w)).toBe(true);
    expect(dateInWindow("2026-10-16", w)).toBe(true);  // 00:00 IST Fri 16 Oct < 18:30 end
    expect(dateInWindow("2026-10-17", w)).toBe(false);
  });
  it("rolling window is exactly 7 days ending now", () => {
    const r = rollingWindow(utc("2026-10-12T00:00:00Z"));
    expect(r.end.getTime() - r.start.getTime()).toBe(7 * 86400e3);
  });
});
