import { describe, expect, it } from "vitest";
import {
  bandFor, NO_SYNOPSIS, recommend, type RecInput, ruleBasedRecommendation, validateExtraction, validateRecommendations,
} from "../supabase/functions/_shared/gemini.ts";
import type { Preferences } from "../supabase/functions/_shared/types.ts";
import { jsonRes, scriptedFetch } from "./helpers.ts";

const prefs: Preferences = {
  owner_name: "Naman", genres: ["Thriller", "Science Fiction", "Indie Drama"], languages: ["hi", "en", "ta"],
  platforms: ["netflix", "prime", "jiohotstar"], media_types: ["movie", "tv"], release_types: ["new_title", "new_season", "new_episode"],
  include_older_additions: false,
};
const inp = (p: Partial<RecInput> = {}): RecInput => ({
  release_id: "r1", title: "Fixture Thriller", media_type: "movie", provider: "netflix", release_type: "new_title",
  genres: ["Thriller", "Crime"], original_language: "hi", spoken_languages: ["hi"], runtime_min: 130, episode_count: null,
  overview: "A detective in Mumbai hunts a killer. The case turns personal.", ...p,
});
const good = { release_id: "r1", verdict: "watch", score: 88, reason: "Tense Hindi crime thriller — squarely your taste.", synopsis: "A Mumbai detective hunts a killer. The case turns personal." };
const geminiBody = (obj: unknown) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify(obj) }] }, finishReason: "STOP" }] });
const cfg = (f: any, keys = ["k1"]) => ({ apiKeys: keys, model: "gemini-2.5-flash", fetchImpl: f });

describe("validateRecommendations", () => {
  it("accepts well-formed output", () => {
    const v = validateRecommendations({ items: [good] }, [inp()], "m");
    expect(v.valid).toHaveLength(1);
    expect(v.invalid).toHaveLength(0);
  });
  it("throws on wrong top-level shape", () => {
    expect(() => validateRecommendations({ nope: [] }, [inp()], "m")).toThrow();
  });
  it.each([
    ["score out of range", { ...good, score: 140 }],
    ["non-integer score", { ...good, score: 70.5 }],
    ["verdict inconsistent with score", { ...good, verdict: "skip", score: 90 }],
    ["unknown verdict", { ...good, verdict: "love" }],
    ["reason mentions a date (availability claim)", { ...good, reason: "Streaming from 14 Oct, great pick" }],
    ["reason too long", { ...good, reason: "x".repeat(400) }],
    ["synopsis invents numbers not in overview", { ...good, synopsis: "A detective hunts 3 killers in 1993." }],
    ["unknown release id", { ...good, release_id: "zzz" }],
  ])("rejects %s", (_name, item) => {
    const v = validateRecommendations({ items: [item] }, [inp()], "m");
    expect(v.valid).toHaveLength(0);
    expect(v.invalid).toEqual(["r1"]);
  });
  it("keeps the AI verdict but trims an over-long synopsis to two TMDB sentences", () => {
    const long = "A detective in Mumbai hunts a killer. The case turns personal. Then more happens. And more.";
    const v = validateRecommendations({ items: [{ ...good, synopsis: long }] }, [inp()], "m");
    expect(v.valid[0].is_fallback).toBe(false);
    expect(v.valid[0].synopsis).toBe("A detective in Mumbai hunts a killer. The case turns personal.");
  });
  it("forces the no-synopsis text when TMDB has no overview", () => {
    const v = validateRecommendations({ items: [{ ...good, synopsis: "Made-up plot." }] }, [inp({ overview: null })], "m");
    expect(v.valid[0].synopsis).toBe(NO_SYNOPSIS);
  });
});

describe("rule-based fallback", () => {
  it("scores genre + language matches and labels itself", () => {
    const r = ruleBasedRecommendation(inp(), prefs);
    expect(r.is_fallback).toBe(true);
    expect(r.reason).toMatch(/^Rule-based \(AI unavailable\)/);
    expect(r.verdict).toBe(bandFor(r.score));
    expect(r.score).toBeGreaterThanOrEqual(65);
  });
  it("skips poor matches", () => {
    const r = ruleBasedRecommendation(inp({ genres: ["Family"], original_language: "ko", spoken_languages: ["ko"] }), prefs);
    expect(r.verdict).toBe("skip");
  });
  it("synopsis is at most two sentences from the overview", () => {
    const r = ruleBasedRecommendation(inp({ overview: "One. Two. Three." }), prefs);
    expect(r.synopsis).toBe("One. Two.");
  });
});

describe("recommend() with mocked Gemini", () => {
  it("uses validated AI output", async () => {
    const f = scriptedFetch(() => jsonRes(geminiBody({ items: [good] })));
    const r = await recommend(cfg(f), prefs, [inp()]);
    expect(r.recs[0].is_fallback).toBe(false);
    expect(r.fallbackCount).toBe(0);
    expect(f.calls[0].init?.headers).toMatchObject({ "x-goog-api-key": "k1" });
  });
  it("falls back per item when the model returns garbage", async () => {
    const f = scriptedFetch(() => jsonRes({ candidates: [{ content: { parts: [{ text: "not json" }] }, finishReason: "STOP" }] }));
    const r = await recommend(cfg(f), prefs, [inp(), inp({ release_id: "r2" })]);
    expect(r.recs.every((x) => x.is_fallback)).toBe(true);
    expect(r.fallbackCount).toBe(2);
    expect(r.errors[0]).toMatch(/non-JSON/);
  });
  it("tries the fallback key on 429 quota errors", async () => {
    const f = scriptedFetch(
      () => jsonRes({ error: { message: "quota" } }, 429, { "retry-after": "0" }),
      () => jsonRes(geminiBody({ items: [good] })),
    );
    const r = await recommend(cfg(f, ["k1", "k2"]), prefs, [inp()]);
    expect(r.recs[0].is_fallback).toBe(false);
    expect((f.calls.at(-1)!.init!.headers as any)["x-goog-api-key"]).toBe("k2");
  });
  it("falls back to the secondary model when the primary is retired (404)", async () => {
    const f = scriptedFetch(
      () => jsonRes({ error: { message: "no longer available" } }, 404),
      () => jsonRes(geminiBody({ items: [good] })),
    );
    const r = await recommend({ ...cfg(f), fallbackModel: "backup-model" }, prefs, [inp()]);
    expect(r.recs[0].is_fallback).toBe(false);
    expect(f.calls[1].url).toContain("backup-model");
  });
  it("safe fallback when the API is down", async () => {
    const f = scriptedFetch(() => jsonRes({ error: { message: "boom" } }, 500, { "retry-after": "0" }));
    const r = await recommend(cfg(f), prefs, [inp()]);
    expect(r.recs[0].model).toBe("rules-fallback");
  });
  it("partially valid batch: valid items kept, invalid ones replaced", async () => {
    const f = scriptedFetch(() => jsonRes(geminiBody({ items: [good, { ...good, release_id: "r2", score: 999 }] })));
    const r = await recommend(cfg(f), prefs, [inp(), inp({ release_id: "r2" })]);
    expect(r.recs.find((x) => x.release_id === "r1")!.is_fallback).toBe(false);
    expect(r.recs.find((x) => x.release_id === "r2")!.is_fallback).toBe(true);
  });
});

describe("validateExtraction (grounding)", () => {
  const article = { id: "a1", headline: "OTT releases this week", publisher: "X", published_at: "2026-10-12T00:00:00Z",
    text: "Fixture Saga streams on Netflix from October 14. Another Show lands on Prime Video this Friday." };
  const base = { article_id: "a1", media_type: "movie", release_type_hint: "new_title", season_number: 0 };
  it("keeps grounded candidates", () => {
    const v = validateExtraction({ candidates: [{ ...base, title: "Fixture Saga", platform: "netflix", stated_release_date: "2026-10-14",
      evidence_quote: "Fixture Saga streams on Netflix from October 14." }] }, [article]);
    expect(v.candidates[0]).toMatchObject({ title: "Fixture Saga", platform: "netflix", stated_release_date: "2026-10-14" });
  });
  it("rejects hallucinated titles / quotes not in the article", () => {
    const v = validateExtraction({ candidates: [{ ...base, title: "Invented Film", platform: "netflix", stated_release_date: "",
      evidence_quote: "Invented Film streams on Netflix." }] }, [article]);
    expect(v.candidates).toHaveLength(0);
    expect(v.rejected).toBe(1);
  });
  it("strips a date the quote does not state", () => {
    const v = validateExtraction({ candidates: [{ ...base, title: "Another Show", platform: "prime", stated_release_date: "2026-10-16",
      evidence_quote: "Another Show lands on Prime Video this Friday." }] }, [article]);
    expect(v.candidates[0].stated_release_date).toBeNull();
    expect(v.candidates[0].flags).toContain("date_not_in_quote");
  });
  it("strips a platform the quote does not mention", () => {
    const v = validateExtraction({ candidates: [{ ...base, title: "Fixture Saga", platform: "jiohotstar", stated_release_date: "",
      evidence_quote: "Fixture Saga streams on Netflix from October 14." }] }, [article]);
    expect(v.candidates[0].platform).toBeNull();
  });
});
