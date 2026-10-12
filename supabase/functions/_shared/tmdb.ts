// TMDB v3 client. Facts only: metadata, posters, India watch providers (data by JustWatch — attribution required),
// episode air dates. TMDB exposes NO "added to platform" date; region release_dates are NOT treated as OTT evidence.
import { type FetchLike, getJson, HttpError } from "./http.ts";
import {
  type EpisodeAir, type MediaType, type Provider, type TitleFacts, TMDB_NETWORK_MAP, TMDB_PROVIDER_IDS, TMDB_PROVIDER_MAP,
} from "./types.ts";

const BASE = "https://api.themoviedb.org/3";
export const POSTER_BASE = "https://image.tmdb.org/t/p/w342";

export class Tmdb {
  requests = 0;
  constructor(private token: string, private fetchImpl?: FetchLike) {}

  get<T>(path: string, params: Record<string, string | number | undefined> = {}): Promise<T> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") qs.set(k, String(v));
    this.requests++;
    return getJson<T>(`${BASE}${path}${qs.size ? `?${qs}` : ""}`,
      { headers: { Authorization: `Bearer ${this.token}`, accept: "application/json" } },
      { retries: 3, timeoutMs: 15000, fetchImpl: this.fetchImpl, baseDelayMs: 1000 });
  }

  async titleFacts(media: MediaType, id: number): Promise<TitleFacts | null> {
    let d: any;
    try {
      d = await this.get(`/${media}/${id}`, {
        language: "en-US",
        append_to_response: media === "movie" ? "watch/providers,release_dates" : "watch/providers",
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 404) return null;
      throw e;
    }
    return factsFromDetail(media, d);
  }

  async seasonEpisodes(tvId: number, season: number): Promise<EpisodeAir[]> {
    const s: any = await this.get(`/tv/${tvId}/season/${season}`, { language: "en-US" });
    const eps: any[] = s.episodes ?? [];
    return eps.filter((e) => e.air_date).map((e) => ({
      season, episode: e.episode_number, air_date: e.air_date, season_episode_count: eps.length, runtime_min: e.runtime ?? null,
    }));
  }

  /** Episodes of the season(s) around last/next aired episode — enough to cover a 7-day window. */
  async recentEpisodes(detail: { last_season?: number | null; next_season?: number | null }, tvId: number): Promise<EpisodeAir[]> {
    const seasons = [...new Set([detail.last_season, detail.next_season].filter((s): s is number => !!s && s > 0))];
    const out: EpisodeAir[] = [];
    for (const s of seasons) out.push(...await this.seasonEpisodes(tvId, s));
    return out;
  }

  async search(query: string, media: MediaType | null): Promise<{ media_type: MediaType; id: number; title: string; date: string | null; popularity: number; original_language: string }[]> {
    const path = media ? `/search/${media}` : "/search/multi";
    const r: any = await this.get(path, { query, include_adult: "false", language: "en-US", region: "IN" });
    return (r.results ?? [])
      .filter((x: any) => (media ?? x.media_type) === "movie" || (media ?? x.media_type) === "tv")
      .slice(0, 8)
      .map((x: any) => ({
        media_type: (media ?? x.media_type) as MediaType, id: x.id, title: x.title ?? x.name,
        date: x.release_date || x.first_air_date || null, popularity: x.popularity ?? 0, original_language: x.original_language,
      }));
  }

  /** All pages of a discover query (bounded). Returns ids and whether the result set was truncated. */
  async discoverIds(media: MediaType, params: Record<string, string | number>, maxPages: number): Promise<{ ids: number[]; truncated: boolean; pages: number }> {
    const ids: number[] = [];
    let page = 1, total = 1;
    do {
      const r: any = await this.get(`/discover/${media}`, { ...params, page });
      total = Math.min(r.total_pages ?? 1, 500);
      for (const x of r.results ?? []) ids.push(x.id);
      page++;
    } while (page <= total && page <= maxPages);
    return { ids, truncated: total > maxPages, pages: page - 1 };
  }

  /** India availability snapshot for one provider (recent titles only; see docs/feasibility.md). */
  snapshotQuery(media: MediaType, provider: Provider, sinceYmd: string): Record<string, string | number> {
    const common = {
      watch_region: "IN", with_watch_providers: TMDB_PROVIDER_IDS[provider].join("|"),
      with_watch_monetization_types: "flatrate|ads|free", include_adult: "false",
    };
    return media === "movie"
      ? { ...common, "primary_release_date.gte": sinceYmd, sort_by: "primary_release_date.desc" }
      : { ...common, "first_air_date.gte": sinceYmd, sort_by: "first_air_date.desc" };
  }

  /** Platform-original series with an episode airing in [from,to] (TMDB air_date filter). */
  originalsAiring(fromYmd: string, toYmd: string, maxPages = 5) {
    return this.discoverIds("tv", {
      with_networks: Object.keys(TMDB_NETWORK_MAP).join("|"),
      "air_date.gte": fromYmd, "air_date.lte": toYmd, sort_by: "popularity.desc",
    }, maxPages);
  }
}

export function factsFromDetail(media: MediaType, d: any): TitleFacts & { last_season: number | null; next_season: number | null; season_count: number | null } {
  const IN = d?.["watch/providers"]?.results?.IN ?? {};
  const avail = new Set<Provider>();
  for (const k of ["flatrate", "ads", "free"]) for (const p of IN[k] ?? []) {
    const mapped = TMDB_PROVIDER_MAP[p.provider_id];
    if (mapped) avail.add(mapped);
  }
  const inDates = (d?.release_dates?.results ?? []).find((r: any) => r.iso_3166_1 === "IN")?.release_dates ?? [];
  return {
    media_type: media,
    tmdb_id: d.id,
    title: d.title ?? d.name,
    original_title: d.original_title ?? d.original_name ?? null,
    original_language: d.original_language ?? null,
    spoken_languages: (d.spoken_languages ?? []).map((l: any) => l.iso_639_1).filter(Boolean),
    genres: (d.genres ?? []).map((g: any) => g.name),
    overview: d.overview || null,
    poster_path: d.poster_path ?? null,
    backdrop_path: d.backdrop_path ?? null,
    release_date: (media === "movie" ? d.release_date : d.first_air_date) || null,
    runtime_min: media === "movie" ? (d.runtime || null) : (d.episode_run_time?.[0] || d.last_episode_to_air?.runtime || null),
    networks: (d.networks ?? []).map((n: any) => n.id),
    available_in: [...avail],
    watch_link: IN.link ?? null,
    in_digital_notes: inDates.filter((x: any) => x.type === 4 && x.note).map((x: any) => ({ date: String(x.release_date).slice(0, 10), note: x.note })),
    last_season: d.last_episode_to_air?.season_number ?? null,
    next_season: d.next_episode_to_air?.season_number ?? null,
    season_count: d.number_of_seasons ?? null,
  };
}

/** Pick the best TMDB match for an article title; returns ambiguity when top results are close. */
export function pickMatch(
  wanted: string, results: { media_type: MediaType; id: number; title: string; date: string | null; popularity: number; original_language: string }[],
  normalize: (s: string) => string, referenceYear: number,
): { match: typeof results[number] | null; confidence: number; ambiguous: boolean } {
  const w = normalize(wanted);
  const scored = results.map((r) => {
    const t = normalize(r.title);
    let s = t === w ? 0.7 : t.startsWith(w) || w.startsWith(t) ? 0.45 : t.includes(w) ? 0.3 : 0;
    const y = r.date ? Number(r.date.slice(0, 4)) : null;
    if (y && Math.abs(referenceYear - y) <= 1) s += 0.2; else if (y && referenceYear - y > 3) s -= 0.15;
    if (["hi", "ta", "te", "ml", "kn", "bn", "mr"].includes(r.original_language)) s += 0.05;
    s += Math.min(0.05, r.popularity / 2000);
    return { r, s };
  }).filter((x) => x.s > 0.3).sort((a, b) => b.s - a.s);
  if (!scored.length) return { match: null, confidence: 0, ambiguous: false };
  const ambiguous = scored.length > 1 && scored[0].s - scored[1].s < 0.1;
  return { match: scored[0].r, confidence: Math.min(1, Math.round(scored[0].s * 100) / 100), ambiguous };
}
