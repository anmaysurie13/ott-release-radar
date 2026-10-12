import { describe, expect, it } from "vitest";
import { verifyTitle } from "../supabase/functions/_shared/verify.ts";
import { digestWindowFor } from "../supabase/functions/_shared/time.ts";
import type { ArticleClaim, SaChange } from "../supabase/functions/_shared/types.ts";
import { facts } from "./helpers.ts";

const now = new Date("2026-10-16T13:00:00Z");
const w = digestWindowFor(now); // [Fri 9 Oct 18:30 IST, Fri 16 Oct 18:30 IST)
const ts = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const sa = (p: Partial<SaChange> = {}): SaChange => ({
  provider: "netflix", item_type: "show", show_type: "movie", tmdb_key: "movie/1001", title: "Fixture Movie",
  timestamp: ts("2026-10-14T07:00:00Z"), link: "https://www.netflix.com/title/1", ...p,
});
const claim = (p: Partial<ArticleClaim> = {}): ArticleClaim => ({
  source_id: "src-1", url: "https://example.com/a", publisher: "Example Times", published_at: "2026-10-12T05:00:00Z",
  stated_platform: "netflix", stated_date: "2026-10-14", quote: "Fixture Movie arrives on Netflix on October 14.", ...p,
});

describe("Streaming Availability evidence", () => {
  it("confirms a new addition inside the window when JustWatch India agrees", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [sa()], episodes: [], claims: [] }, w, now);
    expect(r.verification_status).toBe("confirmed");
    expect(r.date_basis).toBe("sa_change");
    expect(r.available_date).toBe("2026-10-14");
    expect(r.release_type).toBe("new_title");
  });
  it("provider mismatch (SA says Netflix, JustWatch India lists only Prime) → needs review", () => {
    const [r] = verifyTitle({ facts: facts({ available_in: ["prime"] }), provider: "netflix", saChanges: [sa()], episodes: [], claims: [] }, w, now);
    expect(r.verification_status).toBe("needs_review");
    expect(r.notes.join(" ")).toMatch(/Provider mismatch/);
  });
  it("change exactly at the window end is excluded (belongs to next week)", () => {
    const out = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [sa({ timestamp: ts("2026-10-16T13:00:00Z") })], episodes: [], claims: [] }, w, now);
    expect(out).toHaveLength(0);
  });
  it("change exactly at the window start is included", () => {
    const out = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [sa({ timestamp: ts("2026-10-09T13:00:00Z") })], episodes: [], claims: [] }, w, now);
    expect(out[0].verification_status).toBe("confirmed");
    expect(out[0].available_date).toBe("2026-10-09");
  });
  it("old title newly added → separate older_addition category", () => {
    const [r] = verifyTitle({ facts: facts({ release_date: "2019-05-01" }), provider: "netflix", saChanges: [sa()], episodes: [], claims: [] }, w, now);
    expect(r.release_type).toBe("older_addition");
    expect(r.verification_status).toBe("confirmed");
  });
  it("season change → new_season; episode changes released together collapse to one row", () => {
    const tv = facts({ media_type: "tv", tmdb_id: 2002, release_date: "2022-01-01" });
    const out = verifyTitle({
      facts: tv, provider: "netflix", episodes: [], claims: [],
      saChanges: [
        sa({ item_type: "season", show_type: "series", season: 2, tmdb_key: "tv/2002" }),
        sa({ item_type: "episode", show_type: "series", season: 3, episode: 4, tmdb_key: "tv/2002" }),
        sa({ item_type: "episode", show_type: "series", season: 3, episode: 5, tmdb_key: "tv/2002" }),
      ],
    }, w, now);
    expect(out.find((r) => r.release_type === "new_season")?.season_number).toBe(2);
    const ep = out.find((r) => r.release_type === "new_episode")!;
    expect(ep.episode_number).toBe(4);
    expect(ep.episode_count).toBe(2);
  });
});

describe("snapshot fallback", () => {
  it("first-seen inside the window after a complete prior snapshot → confirmed (labelled first observed)", () => {
    const [r] = verifyTitle({
      facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [],
      snapshot: { provider: "netflix", first_seen_at: "2026-10-13T00:30:00Z", added_after: "2026-10-12T00:30:00Z" },
    }, w, now);
    expect(r.verification_status).toBe("confirmed");
    expect(r.date_basis).toBe("snapshot_first_seen");
    expect(r.notes[0]).toMatch(/First observed/);
  });
  it("present in the baseline snapshot (added_after null) cannot be dated → no release", () => {
    const out = verifyTitle({
      facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [],
      snapshot: { provider: "netflix", first_seen_at: "2026-10-13T00:30:00Z", added_after: null },
    }, w, now);
    expect(out).toHaveLength(0);
  });
  it("snapshot + SA for the same title merge into one row with the stronger basis", () => {
    const out = verifyTitle({
      facts: facts(), provider: "netflix", saChanges: [sa()], episodes: [], claims: [],
      snapshot: { provider: "netflix", first_seen_at: "2026-10-15T00:30:00Z", added_after: "2026-10-14T00:30:00Z" },
    }, w, now);
    expect(out).toHaveLength(1);
    expect(out[0].date_basis).toBe("sa_change");
    expect(out[0].evidence.map((e) => e.evidence_type)).toContain("availability_snapshot");
  });
});

describe("TMDB episode air dates", () => {
  const original = facts({ media_type: "tv", tmdb_id: 3003, networks: [213], available_in: ["netflix"], release_date: "2024-03-01" });
  it("platform original + available in India → confirmed new episode", () => {
    const [r] = verifyTitle({ facts: original, provider: "netflix", saChanges: [], claims: [],
      episodes: [{ season: 2, episode: 3, air_date: "2026-10-14" }] }, w, now);
    expect(r.verification_status).toBe("confirmed");
    expect(r.date_basis).toBe("tmdb_episode_air_date");
    expect(r.release_type).toBe("new_episode");
  });
  it("full-season drop collapses into one new_season row with episode count", () => {
    const eps = Array.from({ length: 8 }, (_, i) => ({ season: 2, episode: i + 1, air_date: "2026-10-14" }));
    const out = verifyTitle({ facts: original, provider: "netflix", saChanges: [], claims: [], episodes: eps }, w, now);
    expect(out).toHaveLength(1);
    expect(out[0].release_type).toBe("new_season");
    expect(out[0].episode_count).toBe(8);
  });
  it("non-original (licensed) series air date is NOT India OTT evidence", () => {
    const licensed = { ...original, networks: [6] }; // NBC
    const out = verifyTitle({ facts: licensed, provider: "netflix", saChanges: [], claims: [],
      episodes: [{ season: 28, episode: 1, air_date: "2026-10-14" }] }, w, now);
    expect(out.filter((r) => r.verification_status === "confirmed")).toHaveLength(0);
  });
  it("scheduled (future) air dates inside the window are NOT confirmed before they happen", () => {
    const midweek = new Date("2026-10-12T08:00:00Z"); // Monday 13:30 IST; window runs to Fri 16 Oct 18:30 IST
    const out = verifyTitle({ facts: original, provider: "netflix", saChanges: [], claims: [],
      episodes: [{ season: 2, episode: 4, air_date: "2026-10-12" }, { season: 2, episode: 5, air_date: "2026-10-14" }] }, w, midweek);
    expect(out.map((r) => r.available_date)).toEqual(["2026-10-12"]);
  });
  it("episode outside the window is ignored", () => {
    const out = verifyTitle({ facts: original, provider: "netflix", saChanges: [], claims: [],
      episodes: [{ season: 2, episode: 2, air_date: "2026-10-09" }] }, w, now);
    expect(out).toHaveLength(0);
  });
});

describe("news articles are never proof", () => {
  it("article-only claim in window → needs_review, never confirmed", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [claim()] }, w, now);
    expect(r.verification_status).toBe("needs_review");
    expect(r.date_basis).toBeNull();
  });
  it("TMDB 'Digital' note agreeing with the article still does not confirm", () => {
    const f = facts({ in_digital_notes: [{ date: "2026-10-14", note: "Netflix" }] });
    const [r] = verifyTitle({ facts: f, provider: "netflix", saChanges: [], episodes: [], claims: [claim()] }, w, now);
    expect(r.verification_status).toBe("needs_review");
    expect(r.confidence).toBeLessThan(0.7);
  });
  it("missing launch date → needs_review with null date", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [claim({ stated_date: null })] }, w, now);
    expect(r.verification_status).toBe("needs_review");
    expect(r.available_date).toBeNull();
    expect(r.notes.join(" ")).toMatch(/Missing launch date/);
  });
  it("future (forecast) date → excluded", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [claim({ stated_date: "2026-10-30" })] }, w, now);
    expect(r.verification_status).toBe("excluded");
  });
  it("stale date before the window → excluded", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [], claims: [claim({ stated_date: "2026-09-20" })] }, w, now);
    expect(r.verification_status).toBe("excluded");
  });
  it("conflicting articles are flagged", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [],
      claims: [claim(), claim({ source_id: "src-2", url: "https://example.com/b", stated_date: "2026-10-10" })] }, w, now);
    expect(r.verification_status).toBe("needs_review");
    expect(r.notes.join(" ")).toMatch(/Conflicting articles/);
  });
  it("article naming a different platform is recorded as provider mismatch", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [], episodes: [],
      claims: [claim(), claim({ source_id: "src-3", url: "https://example.com/c", stated_platform: "prime" })] }, w, now);
    expect(r.notes.join(" ")).toMatch(/Provider mismatch/);
  });
  it("article disagreeing with a confirmed structured date becomes conflicting evidence; structured date kept", () => {
    const [r] = verifyTitle({ facts: facts(), provider: "netflix", saChanges: [sa()], episodes: [],
      claims: [claim({ stated_date: "2026-10-10" })] }, w, now);
    expect(r.verification_status).toBe("confirmed");
    expect(r.available_date).toBe("2026-10-14");
    expect(r.evidence.find((e) => e.evidence_type === "news_article")?.stance).toBe("conflicts");
  });
});

describe("Streaming Availability back-catalogue drops", () => {
  it("many seasons of an old show added at once → one older_addition row, not N new seasons", () => {
    const tv = facts({ media_type: "tv", tmdb_id: 37854, release_date: "1999-10-20", available_in: ["netflix"] });
    const drops = [1, 2, 3, 11, 26].map((s) => sa({ item_type: "season", show_type: "series", season: s, tmdb_key: "tv/37854", timestamp: ts("2026-10-12T05:33:00Z") }));
    const out = verifyTitle({ facts: tv, provider: "netflix", saChanges: drops, episodes: [], claims: [] }, w, now);
    expect(out).toHaveLength(1);
    expect(out[0].release_type).toBe("older_addition");
  });
  it("a single new season of a running show stays new_season", () => {
    const tv = facts({ media_type: "tv", tmdb_id: 255752, release_date: "2023-09-01", available_in: ["netflix"] });
    const [r] = verifyTitle({ facts: tv, provider: "netflix", saChanges: [sa({ item_type: "season", show_type: "series", season: 2, tmdb_key: "tv/255752" })], episodes: [], claims: [] }, w, now);
    expect(r.release_type).toBe("new_season");
  });
});

describe("Streaming Availability show + season-1 pair", () => {
  it("a new show and its season 1 added together produce one row", () => {
    const tv = facts({ media_type: "tv", tmdb_id: 4242, release_date: "2026-10-01", available_in: ["jiohotstar"] });
    const t = ts("2026-10-11T10:00:00Z");
    const out = verifyTitle({ facts: tv, provider: "jiohotstar", episodes: [], claims: [], saChanges: [
      sa({ provider: "jiohotstar", item_type: "show", show_type: "series", tmdb_key: "tv/4242", timestamp: t }),
      sa({ provider: "jiohotstar", item_type: "season", show_type: "series", season: 1, tmdb_key: "tv/4242", timestamp: t }),
    ] }, w, now);
    expect(out).toHaveLength(1);
    expect(out[0].release_type).toBe("new_title");
  });
});
