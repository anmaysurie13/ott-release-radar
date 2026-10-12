// DEVELOPMENT FIXTURES — fictional titles for UI work only. Shown ONLY with ?fixtures=1 or when Supabase env is missing,
// always under a "Development fixtures — not real data" banner. Never mixed with live data.
import type { DigestRun, PipelineRun, Preferences, Release, Source } from "./types";

const today = new Date();
const d = (offset: number) => new Date(today.getTime() - offset * 86400e3 + 330 * 60e3).toISOString().slice(0, 10);

const base = {
  spoken_languages: [], backdrop_path: null, poster_path: null, overview: null, last_checked_at: today.toISOString(),
  verification_notes: "FIXTURE — not verified", available_at: null, episode_number: null, season_number: null, episode_count: null,
  watch_link: null, release_evidence: [], confidence: 0.9, year: 2026,
};

export const FIXTURE_RELEASES: Release[] = [
  { ...base, id: "fx-1", media_type: "movie", tmdb_id: 1, provider: "netflix", release_type: "new_title", available_date: d(1),
    date_basis: "sa_change", verification_status: "confirmed", title: "Fixture: Signal Lost", original_language: "hi",
    genres: ["Thriller", "Mystery"], runtime_min: 128, overview: "Fixture overview.",
    recommendations: [{ id: "r1", verdict: "watch", score: 91, reason: "FIXTURE — tense Hindi thriller, your core genre.", synopsis: "Fixture synopsis line one. Line two.", model: "fixture", is_fallback: false, created_at: today.toISOString(), preferences_hash: "fx" }] },
  { ...base, id: "fx-2", media_type: "tv", tmdb_id: 2, provider: "prime", release_type: "new_season", season_number: 2, episode_count: 8,
    available_date: d(2), date_basis: "tmdb_episode_air_date", verification_status: "confirmed", title: "Fixture: Orbit Nine",
    original_language: "en", genres: ["Sci-Fi & Fantasy", "Drama"], runtime_min: 50,
    recommendations: [{ id: "r2", verdict: "watch", score: 78, reason: "FIXTURE — English sci-fi season drop.", synopsis: "Fixture synopsis.", model: "fixture", is_fallback: false, created_at: today.toISOString(), preferences_hash: "fx" }] },
  { ...base, id: "fx-3", media_type: "movie", tmdb_id: 3, provider: "jiohotstar", release_type: "new_title", available_date: d(3),
    date_basis: "snapshot_first_seen", verification_status: "confirmed", title: "Fixture: Kadal Kathai", original_language: "ta",
    genres: ["Drama"], runtime_min: 112,
    recommendations: [{ id: "r3", verdict: "maybe", score: 58, reason: "Rule-based (AI unavailable): matches Indie Drama; in Tamil.", synopsis: "Fixture synopsis.", model: "rules-fallback", is_fallback: true, created_at: today.toISOString(), preferences_hash: "fx" }] },
  { ...base, id: "fx-4", media_type: "tv", tmdb_id: 4, provider: "netflix", release_type: "new_episode", season_number: 1, episode_number: 5, episode_count: 2,
    available_date: d(4), date_basis: "tmdb_episode_air_date", verification_status: "confirmed", title: "Fixture: Laugh Track",
    original_language: "en", genres: ["Comedy"], runtime_min: 25,
    recommendations: [{ id: "r4", verdict: "skip", score: 22, reason: "FIXTURE — comedy is outside your saved genres.", synopsis: "Fixture synopsis.", model: "fixture", is_fallback: false, created_at: today.toISOString(), preferences_hash: "fx" }] },
];

export const FIXTURE_PREFS: Preferences = {
  owner_name: "Naman", genres: ["Thriller", "Science Fiction", "Indie Drama"], languages: ["hi", "en", "ta"],
  platforms: ["netflix", "prime", "jiohotstar"], media_types: ["movie", "tv"], release_types: ["new_title", "new_season", "new_episode"],
  include_older_additions: false, notes: null, digest_enabled: true,
};
export const FIXTURE_RUNS: PipelineRun[] = [
  { id: "fx-run", task: "collect", trigger: "fixture", status: "succeeded", window_key: d(0), started_at: today.toISOString(), finished_at: today.toISOString(), error: null, stats: { confirmed: 4 }, source_health: { fixture: "not real" } },
];
export const FIXTURE_DIGESTS: DigestRun[] = [];
export const FIXTURE_SOURCES: Source[] = [];
