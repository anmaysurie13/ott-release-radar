import { describe, expect, it } from "vitest";
import { fetchWithRetry, mapLimit, redactUrl } from "../supabase/functions/_shared/http.ts";
import { extractArticleText, parseRss } from "../supabase/functions/_shared/news.ts";
import { fetchSaChanges, parseTmdbKey } from "../supabase/functions/_shared/streaming_availability.ts";
import { factsFromDetail, pickMatch } from "../supabase/functions/_shared/tmdb.ts";
import { normalizeTitle } from "../supabase/functions/_shared/dedupe.ts";
import { jsonRes, noSleep, scriptedFetch } from "./helpers.ts";

describe("fetchWithRetry (rate limits / retries / timeouts)", () => {
  it("retries 503 then succeeds", async () => {
    const f = scriptedFetch(() => new Response("x", { status: 503 }), () => jsonRes({ ok: 1 }));
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f, sleep: noSleep });
    expect(r.status).toBe(200);
    expect(f.calls).toHaveLength(2);
  });
  it("honours Retry-After on 429", async () => {
    const waits: number[] = [];
    const f = scriptedFetch(() => new Response("", { status: 429, headers: { "retry-after": "7" } }), () => jsonRes({}));
    await fetchWithRetry("https://x", {}, { fetchImpl: f, sleep: async (ms) => { waits.push(ms); } });
    expect(waits).toEqual([7000]);
  });
  it("returns the final 429 after exhausting retries (caller decides)", async () => {
    const f = scriptedFetch(() => new Response("", { status: 429, headers: { "retry-after": "0" } }));
    const r = await fetchWithRetry("https://x", {}, { fetchImpl: f, sleep: noSleep, retries: 2 });
    expect(r.status).toBe(429);
    expect(f.calls).toHaveLength(3);
  });
  it("throws after repeated network errors, with secrets redacted", async () => {
    const f = scriptedFetch(() => { throw new Error("ECONNRESET"); });
    await expect(fetchWithRetry("https://api.telegram.org/bot1:SECRET/x", {}, { fetchImpl: f, sleep: noSleep }))
      .rejects.toThrow(/bot<redacted>/);
    expect(redactUrl("https://a.b/?api_key=zzz&q=1")).toBe("https://a.b/?api_key=<redacted>&q=1");
  });
  it("mapLimit bounds concurrency", async () => {
    let active = 0, peak = 0;
    await mapLimit([1, 2, 3, 4, 5, 6], 2, async () => { active++; peak = Math.max(peak, active); await new Promise((r) => setTimeout(r, 5)); active--; });
    expect(peak).toBe(2);
  });
});

describe("Streaming Availability client (mocked — live status: not subscribed)", () => {
  it("403 not subscribed → unavailable (pipeline falls back, nothing invented)", async () => {
    const f = scriptedFetch(() => jsonRes({ message: "You are not subscribed to this API." }, 403));
    const r = await fetchSaChanges({ apiKey: "k", fromSec: 0, toSec: 1, fetchImpl: f });
    expect(r.status).toBe("unavailable");
    expect(r.changes).toHaveLength(0);
  });
  it("maps services, skips rent/buy, follows the cursor", async () => {
    const page1 = { changes: [
      { changeType: "new", itemType: "show", showId: "s1", showType: "movie", service: { id: "netflix", name: "Netflix" }, streamingOptionType: "subscription", timestamp: 100, link: "https://n" },
      { changeType: "new", itemType: "show", showId: "s2", showType: "movie", service: { id: "prime", name: "Prime Video" }, streamingOptionType: "rent", timestamp: 101 },
    ], shows: { s1: { title: "Fixture A", tmdbId: "movie/11" }, s2: { title: "Rental", tmdbId: "movie/12" } }, hasMore: true, nextCursor: "c2" };
    const page2 = { changes: [
      { changeType: "new", itemType: "show", showId: "s3", showType: "series", service: { id: "hotstar", name: "JioHotstar" }, streamingOptionType: "subscription", timestamp: 102 },
    ], shows: { s3: { title: "Fixture B", tmdbId: "tv/13" } }, hasMore: false };
    const f = scriptedFetch(() => jsonRes(page1), () => jsonRes(page2));
    const r = await fetchSaChanges({ apiKey: "k", fromSec: 0, toSec: 1, itemTypes: ["show"], fetchImpl: f });
    expect(r.status).toBe("ok");
    expect(r.changes.map((c) => [c.provider, c.tmdb_key])).toEqual([["netflix", "movie/11"], ["jiohotstar", "tv/13"]]);
    expect(f.calls[1].url).toContain("cursor=c2");
  });
  it("missing key → unavailable without calling the API", async () => {
    const f = scriptedFetch(() => jsonRes({}));
    expect((await fetchSaChanges({ apiKey: undefined, fromSec: 0, toSec: 1, fetchImpl: f })).status).toBe("unavailable");
    expect(f.calls).toHaveLength(0);
    expect(parseTmdbKey("tv/42")).toEqual({ media_type: "tv", id: 42 });
    expect(parseTmdbKey("bogus")).toBeNull();
  });
});

describe("TMDB parsing", () => {
  it("maps India providers; rent/buy and non-subscription ids ignored; region notes are context only", () => {
    const f = factsFromDetail("movie", {
      id: 5, title: "Fixture", original_language: "ta", spoken_languages: [{ iso_639_1: "ta" }], genres: [{ name: "Thriller" }],
      release_date: "2026-09-01", runtime: 140, overview: "o",
      "watch/providers": { results: { IN: { link: "https://tmdb/watch", flatrate: [{ provider_id: 2336 }], rent: [{ provider_id: 119 }], ads: [{ provider_id: 613 }] } } },
      release_dates: { results: [{ iso_3166_1: "IN", release_dates: [{ type: 4, note: "JioHotstar", release_date: "2026-10-10T00:00:00.000Z" }, { type: 3, note: "", release_date: "2026-09-01T00:00:00.000Z" }] }] },
    });
    expect(f.available_in).toEqual(["jiohotstar"]);
    expect(f.in_digital_notes).toEqual([{ date: "2026-10-10", note: "JioHotstar" }]);
  });
  it("title matching flags ambiguity instead of guessing", () => {
    const results = [
      { media_type: "movie" as const, id: 1, title: "Kingdom", date: "2026-07-31", popularity: 50, original_language: "te" },
      { media_type: "movie" as const, id: 2, title: "Kingdom", date: "2026-03-01", popularity: 48, original_language: "ko" },
    ];
    const m = pickMatch("Kingdom", results, normalizeTitle, 2026);
    expect(m.ambiguous).toBe(true);
    const m2 = pickMatch("Kingdom", results.slice(0, 1), normalizeTitle, 2026);
    expect(m2).toMatchObject({ ambiguous: false });
    expect(m2.match?.id).toBe(1);
  });
});

describe("RSS / article parsing", () => {
  it("parses Google News items and strips the publisher suffix", () => {
    const xml = `<rss><channel><item><title>New OTT releases: 9 titles on Netflix &amp; Prime - Example Times</title>
      <link>https://news.google.com/rss/articles/abc?oc=5</link><pubDate>Fri, 09 Oct 2026 05:17:43 GMT</pubDate>
      <description>&lt;a href="x"&gt;New OTT releases&lt;/a&gt;</description><source url="https://ex.com">Example Times</source></item></channel></rss>`;
    const [i] = parseRss(xml, "news_rss", null, "q");
    expect(i.title).toBe("New OTT releases: 9 titles on Netflix & Prime");
    expect(i.publisher).toBe("Example Times");
    expect(i.published_at).toBe("2026-10-09T05:17:43.000Z");
    expect(i.url).toBe("https://news.google.com/rss/articles/abc");
  });
  it("extracts paragraph text from an article page", () => {
    const html = `<html><nav><p>Menu</p></nav><article><p>Fixture Saga streams on Netflix from October 14.</p><script>x()</script><p>short</p></article></html>`;
    expect(extractArticleText(html)).toBe("Fixture Saga streams on Netflix from October 14.");
  });
});
