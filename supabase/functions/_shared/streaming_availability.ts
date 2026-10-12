// Streaming Availability API (Movie of the Night) via RapidAPI — /changes for country=in.
// Fields used (per docs.movieofthenight.com): changes[].{changeType,itemType,showId,showType,service,season,episode,timestamp,link},
// shows{id → {title, tmdbId:"movie/123"|"tv/456"}}, hasMore, nextCursor.
// Status 2026-10-12: free BASIC plan subscribed; live /countries/in lists netflix, prime, hotstar (subscription)
// and /changes returns India 'new' changes with timestamps + tmdbId. On 401/403 the pipeline falls back to the snapshot diff.
import { type FetchLike, fetchWithRetry } from "./http.ts";
import { providerFromName, type SaChange } from "./types.ts";

export const SA_HOST = "streaming-availability.p.rapidapi.com";

export interface SaResult {
  status: "ok" | "unavailable" | "error";
  reason?: string;
  changes: SaChange[];
  requests: number;
}

export async function fetchSaChanges(o: {
  apiKey: string | undefined; host?: string; fromSec: number; toSec: number;
  itemTypes?: ("show" | "season" | "episode")[]; maxPagesPerType?: number; fetchImpl?: FetchLike;
}): Promise<SaResult> {
  if (!o.apiKey) return { status: "unavailable", reason: "RAPIDAPI_KEY not configured", changes: [], requests: 0 };
  const host = o.host ?? SA_HOST;
  // Item types are fetched in parallel (each paginates sequentially) to stay inside the Edge time budget.
  const results = await Promise.all((o.itemTypes ?? ["show", "season", "episode"]).map((t) => fetchType(t, o, host)));
  const bad = results.find((r) => r.status !== "ok");
  const changes = results.flatMap((r) => r.changes);
  const requests = results.reduce((n, r) => n + r.requests, 0);
  if (bad) return { status: bad.status, reason: bad.reason, changes, requests };
  const truncated = results.filter((r) => r.truncated).map((r) => r.itemType);
  return { status: "ok", changes, requests, reason: truncated.length ? `page cap reached for ${truncated.join(", ")} (oldest changes in window not fetched)` : undefined };
}

async function fetchType(itemType: "show" | "season" | "episode", o: { apiKey?: string; fromSec: number; toSec: number; maxPagesPerType?: number; fetchImpl?: FetchLike }, host: string):
  Promise<SaResult & { itemType: string; truncated: boolean }> {
  const out: SaChange[] = [];
  let requests = 0, cursor: string | undefined, truncated = false;
  const maxPages = o.maxPagesPerType ?? (itemType === "show" ? 8 : 4);
  for (let page = 0; page < maxPages; page++) {
    const qs = new URLSearchParams({
      country: "in", change_type: "new", item_type: itemType, from: String(o.fromSec), to: String(o.toSec),
      include_unknown_dates: "false", order_direction: "desc", output_language: "en", // newest first: page cap drops oldest, not newest
      // subscription catalogs only (no rent/buy/add-on channels) — also keeps the free 1,000 req/month quota safe
      catalogs: "netflix,prime.subscription,hotstar",
    });
    if (cursor) qs.set("cursor", cursor);
    requests++;
    let res: Response;
    try {
      res = await fetchWithRetry(`https://${host}/changes?${qs}`, {
        headers: { "x-rapidapi-key": o.apiKey!, "x-rapidapi-host": host },
      }, { retries: 2, timeoutMs: 20000, fetchImpl: o.fetchImpl, baseDelayMs: 1500 });
    } catch (e) {
      return { status: "error", reason: String(e), changes: out, requests, itemType, truncated };
    }
    const body = await res.json().catch(() => null) as any;
    if (res.status === 403 || res.status === 401) {
      return { status: "unavailable", reason: `${res.status} ${body?.message ?? "forbidden"}`, changes: out, requests, itemType, truncated };
    }
    if (!res.ok) return { status: "error", reason: `${res.status} ${body?.message ?? ""}`.trim(), changes: out, requests, itemType, truncated };
    for (const c of body?.changes ?? []) {
      const provider = providerFromName(`${c?.service?.id ?? ""} ${c?.service?.name ?? ""}`);
      if (!provider || provider === "other" || typeof c?.timestamp !== "number") continue;
      // subscription/ads catalogs only (exclude rent/buy/addon stores)
      if (c.streamingOptionType && !["subscription", "free", "ads"].includes(c.streamingOptionType)) continue;
      const show = body?.shows?.[c.showId] ?? {};
      out.push({
        provider, item_type: c.itemType, show_type: c.showType === "movie" ? "movie" : "series",
        tmdb_key: typeof show.tmdbId === "string" ? show.tmdbId : null,
        title: show.title ?? "", timestamp: c.timestamp, season: c.season ?? null, episode: c.episode ?? null, link: c.link ?? null,
      });
    }
    if (!body?.hasMore || !body?.nextCursor) break;
    if (page === maxPages - 1) truncated = true;
    cursor = body.nextCursor;
  }
  return { status: "ok", changes: out, requests, itemType, truncated };
}

export function parseTmdbKey(k: string | null): { media_type: "movie" | "tv"; id: number } | null {
  const m = k?.match(/^(movie|tv)\/(\d+)$/);
  return m ? { media_type: m[1] as "movie" | "tv", id: Number(m[2]) } : null;
}
