import { describe, expect, it } from "vitest";
import { canonicalUrl, dedupeKey, mergeReleases, normalizeTitle } from "../supabase/functions/_shared/dedupe.ts";
import type { VerifiedRelease } from "../supabase/functions/_shared/types.ts";
import { planSnapshotInserts } from "../supabase/functions/_shared/snapshot.ts";

const rel = (p: Partial<VerifiedRelease> = {}): VerifiedRelease => ({
  media_type: "movie", tmdb_id: 1, provider: "netflix", release_type: "new_title", season_number: null, episode_number: null,
  available_date: "2026-10-14", available_at: null, date_basis: "snapshot_first_seen", verification_status: "confirmed",
  confidence: 0.75, notes: ["a"], evidence: [{ evidence_type: "availability_snapshot", stance: "supports" }], ...p,
});

describe("mergeReleases", () => {
  it("same title/provider/type within 3 days → one row, strongest basis kept, evidence unioned", () => {
    const out = mergeReleases([
      rel(),
      rel({ available_date: "2026-10-13", date_basis: "sa_change", confidence: 0.95, notes: ["b"],
        evidence: [{ evidence_type: "availability_change", stance: "supports", url: "https://x" }] }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].date_basis).toBe("sa_change");
    expect(out[0].available_date).toBe("2026-10-13");
    expect(out[0].evidence).toHaveLength(2);
    expect(out[0].notes).toEqual(["b", "a"]);
  });
  it("confirmed beats needs_review regardless of order", () => {
    const out = mergeReleases([rel({ verification_status: "needs_review", date_basis: null, confidence: 0.4 }), rel()]);
    expect(out[0].verification_status).toBe("confirmed");
  });
  it("different providers, seasons or far-apart dates stay separate", () => {
    expect(mergeReleases([rel(), rel({ provider: "prime" })])).toHaveLength(2);
    expect(mergeReleases([rel({ media_type: "tv", release_type: "new_season", season_number: 1 }),
      rel({ media_type: "tv", release_type: "new_season", season_number: 2 })])).toHaveLength(2);
    expect(mergeReleases([rel(), rel({ available_date: "2026-11-30" })])).toHaveLength(2);
  });
  it("exact duplicates collapse and dedupeKey is stable", () => {
    expect(mergeReleases([rel(), rel()])).toHaveLength(1);
    expect(dedupeKey(rel())).toBe("movie:1:netflix:new_title:::2026-10-14");
  });
});

describe("normalisation", () => {
  it("normalizeTitle ignores punctuation, case and season suffixes", () => {
    expect(normalizeTitle("The Family Man: Season 3")).toBe(normalizeTitle("the family man"));
    expect(normalizeTitle("Paatal Lok – S2")).toBe("paatal lok");
  });
  it("canonicalUrl strips tracking params and fragments", () => {
    expect(canonicalUrl("https://News.example.com/a/?utm_source=x&id=2#top")).toBe("https://news.example.com/a/?id=2");
  });
});

describe("snapshot diff planning", () => {
  const seen = [
    { provider: "netflix" as const, media_type: "movie" as const, tmdb_id: 1 },
    { provider: "netflix" as const, media_type: "movie" as const, tmdb_id: 2 },
    { provider: "netflix" as const, media_type: "movie" as const, tmdb_id: 2 },
  ];
  it("baseline run: everything inserted but undatable (added_after null)", () => {
    const rows = planSnapshotInserts({ seen, existingKeys: new Set(), previousCompleteStartedAt: null, now: new Date("2026-10-12T00:30:00Z"), runId: "r1" });
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.added_after === null)).toBe(true);
  });
  it("later run: only unseen titles inserted, dated after previous complete snapshot", () => {
    const rows = planSnapshotInserts({ seen, existingKeys: new Set(["netflix:movie:1"]), previousCompleteStartedAt: "2026-10-12T00:30:00Z", now: new Date("2026-10-13T00:30:00Z"), runId: "r2" });
    expect(rows.map((r) => r.tmdb_id)).toEqual([2]);
    expect(rows[0].added_after).toBe("2026-10-12T00:30:00Z");
  });
});
