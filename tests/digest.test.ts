import { describe, expect, it } from "vitest";
import { buildDigestBlocks, type DigestRelease, formatEpisodes } from "../supabase/functions/_shared/digest.ts";
import { digestWindowFor } from "../supabase/functions/_shared/time.ts";
import { passesPreferences } from "../supabase/functions/_shared/pipeline.ts";

const w = digestWindowFor(new Date("2026-10-16T13:00:00Z"));
const item = (p: Partial<DigestRelease> = {}): DigestRelease => ({
  id: "1", title: "Fixture <Thriller> & Co", year: 2026, media_type: "movie", provider: "netflix", release_type: "new_title",
  season_number: null, episode_number: null, episode_count: null, available_date: "2026-10-14", available_at: null,
  date_basis: "sa_change", genres: ["Thriller"], original_language: "hi", runtime_min: 125, watch_link: "https://w", evidence_url: "https://e",
  rec: { verdict: "watch", score: 90, reason: "Fits.", synopsis: "Two lines.", is_fallback: false }, ...p,
});

describe("digest builder", () => {
  it("sections: top / maybe / skipped / older; HTML-escaped; facts vs AI labelled", () => {
    const { blocks, sections } = buildDigestBlocks({
      window: w, includeOlder: true, reviewCount: 2, dashboardUrl: "https://dash", isTest: false, degradedSources: [],
      items: [
        item(),
        item({ id: "2", title: "Maybe One", rec: { verdict: "maybe", score: 50, reason: "Ok.", synopsis: "S.", is_fallback: true } }),
        item({ id: "3", title: "Skip One", rec: { verdict: "skip", score: 10, reason: "No.", synopsis: "S.", is_fallback: false } }),
        item({ id: "4", title: "Old One", release_type: "older_addition" }),
      ],
    });
    const text = blocks.join("\n\n");
    expect(text).toContain("Fixture &lt;Thriller&gt; &amp; Co");
    expect(text).toContain("⭐ <b>Top matches</b>");
    expect(text).toContain("📺 New on your apps: Netflix <b>4</b> · Prime Video — · JioHotstar —");
    expect(text).toContain("(rules)");
    expect(text).toContain("Skipped as poor matches: Skip One");
    expect(text).toContain("Older titles newly added");
    expect(text).toContain("2 unverified item(s) await review — not included above.");
    expect(text).toMatch(/AI opinion \(Gemini\)/);
    expect(text).toContain("2h 05m");
    expect(sections.map((s) => s.section)).toEqual(["top", "more", "skipped", "older"]);
  });
  it("test sends are clearly labelled and empty weeks say so", () => {
    const { blocks } = buildDigestBlocks({ window: w, includeOlder: false, reviewCount: 0, dashboardUrl: null, isTest: true, degradedSources: ["Streaming Availability unavailable"], items: [] });
    expect(blocks[0]).toMatch(/TEST MESSAGE/);
    expect(blocks.join()).toContain("No confirmed new releases");
    expect(blocks.join()).toContain("Limited sources this week");
  });
  it("daily-show episodes collapse to one item per show/season; skipped list is capped", () => {
    const eps = Array.from({ length: 6 }, (_, i) => item({ id: `e${i}`, title: "Daily Show", media_type: "tv", release_type: "new_episode",
      season_number: 20, episode_number: 30 + i, episode_count: 1, available_date: `2026-10-1${i}`,
      rec: { verdict: "skip", score: 10, reason: "No.", synopsis: "S.", is_fallback: false } }));
    const others = Array.from({ length: 9 }, (_, i) => item({ id: `s${i}`, title: `Skip ${i}`, rec: { verdict: "skip", score: 5, reason: "No.", synopsis: "S.", is_fallback: false } }));
    const { blocks } = buildDigestBlocks({ window: w, includeOlder: false, reviewCount: 0, dashboardUrl: null, isTest: false, degradedSources: [], items: [...eps, ...others] });
    const skippedLine = blocks.find((b) => b.startsWith("⏭"))!;
    expect(skippedLine.match(/Daily Show/g)).toHaveLength(1);
    expect(skippedLine).toContain("and 2 more");
  });
  it("episode formatting", () => {
    expect(formatEpisodes({ media_type: "tv", season_number: 2, episode_number: 3, episode_count: 3 })).toBe("S2 E3–E5");
    expect(formatEpisodes({ media_type: "tv", season_number: 2, episode_number: null, episode_count: 8 })).toBe("S2 · 8 episodes");
    expect(formatEpisodes({ media_type: "tv", season_number: 24, episode_number: null, episode_count: 1 })).toBe("S24 · 1 episode");
  });
});

describe("preference filter", () => {
  it("language is a hard filter on TMDB original/spoken languages (Hindi, English, Tamil by default)", () => {
    const naman = { owner_name: "Naman", genres: ["Thriller", "Science Fiction", "Indie Drama"], languages: ["hi", "en", "ta"],
      platforms: ["netflix", "prime", "jiohotstar"] as any, media_types: ["movie", "tv"] as any, release_types: ["new_title", "new_season", "new_episode"] as any, include_older_additions: false };
    const base = { provider: "jiohotstar", media_type: "tv", release_type: "new_episode" };
    expect(passesPreferences({ ...base, original_language: "hi", spoken_languages: ["hi"] }, naman)).toBe(true);
    expect(passesPreferences({ ...base, original_language: "ta", spoken_languages: [] }, naman)).toBe(true);
    expect(passesPreferences({ ...base, original_language: "ml", spoken_languages: ["ml"] }, naman)).toBe(false); // Bigg Boss Malayalam
    expect(passesPreferences({ ...base, original_language: "pl", spoken_languages: ["pl", "en"] }, naman)).toBe(false); // spoken English alone doesn't count
    expect(passesPreferences({ ...base, original_language: "ja", spoken_languages: ["ja"] }, naman)).toBe(false);
  });
  const prefs = { owner_name: "N", genres: [], languages: [], platforms: ["netflix", "prime"] as any, media_types: ["movie"] as any,
    release_types: ["new_title"] as any, include_older_additions: false };
  it("filters platform, media type and release type; older additions only when opted in", () => {
    expect(passesPreferences({ provider: "netflix", media_type: "movie", release_type: "new_title" }, prefs)).toBe(true);
    expect(passesPreferences({ provider: "jiohotstar", media_type: "movie", release_type: "new_title" }, prefs)).toBe(false);
    expect(passesPreferences({ provider: "netflix", media_type: "tv", release_type: "new_title" }, prefs)).toBe(false);
    expect(passesPreferences({ provider: "netflix", media_type: "movie", release_type: "older_addition" }, prefs)).toBe(false);
    expect(passesPreferences({ provider: "netflix", media_type: "movie", release_type: "older_addition" }, { ...prefs, include_older_additions: true })).toBe(true);
  });
});
