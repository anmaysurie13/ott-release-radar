// Orchestration: snapshot · collect · deliver · weekly. All writes use the service-role client.
// deno-lint-ignore-file no-explicit-any
import { dedupeKey, identityKey, normalizeTitle, SAME_EVENT_DAYS } from "./dedupe.ts";
import { buildDigestBlocks, type DigestRelease } from "./digest.ts";
import { type ArticleInput, DEFAULT_FALLBACK_MODEL, DEFAULT_MODEL, extractCandidates, type GeminiConfig, type RecInput, recommend } from "./gemini.ts";
import { mapLimit } from "./http.ts";
import { discoverNews } from "./news.ts";
import { availabilityKey, planSnapshotInserts, type SeenTitle } from "./snapshot.ts";
import { fetchSaChanges, parseTmdbKey } from "./streaming_availability.ts";
import { chunkBlocks, type DeliveryStore, sendChunks, sha256Prefix } from "./telegram.ts";
import { DAY_MS, dateInWindow, daysBetween, digestWindowFor, inWindow, istDate, type TimeWindow, upcomingWindow } from "./time.ts";
import { pickMatch, Tmdb } from "./tmdb.ts";
import {
  type ArticleClaim, type EpisodeAir, type MediaType, type Preferences, type Provider, PROVIDERS,
  type SaChange, type SnapshotObservation, type TitleFacts, TMDB_NETWORK_MAP, type VerifiedRelease,
} from "./types.ts";
import { verifyTitle } from "./verify.ts";

export interface Env {
  TMDB_READ_TOKEN: string;
  RAPIDAPI_KEY?: string;
  GEMINI_API_KEY?: string;
  GEMINI_API_KEY_FALLBACK?: string;
  GEMINI_MODEL?: string;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_CHAT_ID?: string;
  LIVE_SEND_ENABLED?: string;   // "true" only after the owner approves live sends
  DASHBOARD_URL?: string;
}

export interface Ctx {
  db: any;                       // SupabaseClient (service role)
  env: Env;
  now: () => Date;
  deadline: number;              // epoch ms — stop starting new work after this
  fetchImpl?: typeof fetch;
}

const SNAPSHOT_MAX_PAGES = 60;
const SNAPSHOT_LOOKBACK_DAYS = 365;

function geminiCfg(env: Env): GeminiConfig {
  const model = env.GEMINI_MODEL || DEFAULT_MODEL;
  return {
    apiKeys: [env.GEMINI_API_KEY ?? "", env.GEMINI_API_KEY_FALLBACK ?? ""].filter(Boolean), model,
    fallbackModel: model === DEFAULT_FALLBACK_MODEL ? undefined : DEFAULT_FALLBACK_MODEL,
  };
}
function must<T>(r: { data: T; error: any }, what: string): T {
  if (r.error) throw new Error(`${what}: ${r.error.message ?? r.error}`);
  return r.data;
}
function timeLeft(ctx: Ctx) { return ctx.deadline - Date.now(); }

// ------------------------------------------------------------------ runs

export async function startRun(ctx: Ctx, task: string, trigger: string, w?: TimeWindow): Promise<string> {
  const row = must(await ctx.db.from("pipeline_runs").insert({
    task, trigger, window_key: w?.key ?? null, window_start: w?.start.toISOString() ?? null, window_end: w?.end.toISOString() ?? null,
  }).select("id").single(), "start run") as any;
  return row.id;
}
export async function finishRun(ctx: Ctx, id: string, status: string, stats: unknown, health: unknown, error?: string) {
  await ctx.db.from("pipeline_runs").update({
    status, stats, source_health: health, error: error?.slice(0, 2000) ?? null, finished_at: new Date().toISOString(),
  }).eq("id", id);
}

export async function loadPreferences(ctx: Ctx): Promise<Preferences & { digest_enabled: boolean; hash: string }> {
  const p = must(await ctx.db.from("preferences").select("*").eq("id", 1).single(), "load preferences") as any;
  const prefs: Preferences = {
    owner_name: p.owner_name, genres: p.genres, languages: p.languages, platforms: p.platforms, media_types: p.media_types,
    release_types: p.release_types, include_older_additions: p.include_older_additions, notes: p.notes,
  };
  const hash = (await sha256Prefix(JSON.stringify([prefs.genres, prefs.languages, prefs.notes ?? "", geminiCfg(ctx.env).model]))).slice(0, 12);
  return { ...prefs, digest_enabled: p.digest_enabled, hash };
}

// ------------------------------------------------------------------ snapshot

export async function runSnapshot(ctx: Ctx, trigger: string) {
  const now = ctx.now();
  const runRow = must(await ctx.db.from("snapshot_runs").insert({ started_at: now.toISOString() }).select("id").single(), "snapshot run") as any;
  const pipeRun = await startRun(ctx, "snapshot", trigger);
  const tmdb = new Tmdb(ctx.env.TMDB_READ_TOKEN, ctx.fetchImpl);
  const prev = must(await ctx.db.from("snapshot_runs").select("id, started_at").eq("complete", true)
    .lt("started_at", now.toISOString()).order("started_at", { ascending: false }).limit(1), "prev snapshot") as any[];
  const prevComplete: string | null = prev[0]?.started_at ?? null;
  const since = istDate(new Date(now.getTime() - SNAPSHOT_LOOKBACK_DAYS * DAY_MS));
  const jobs = PROVIDERS.flatMap((p) => (["movie", "tv"] as MediaType[]).map((m) => ({ p, m })));
  let complete = true, pages = 0;
  const errors: string[] = [];
  const seen: SeenTitle[] = [];
  await mapLimit(jobs, 3, async ({ p, m }) => {
    try {
      const r = await tmdb.discoverIds(m, tmdb.snapshotQuery(m, p, since), SNAPSHOT_MAX_PAGES);
      pages += r.pages;
      if (r.truncated) { complete = false; errors.push(`${p}/${m} truncated at ${SNAPSHOT_MAX_PAGES} pages`); }
      for (const id of r.ids) seen.push({ provider: p, media_type: m, tmdb_id: id });
    } catch (e) { complete = false; errors.push(`${p}/${m}: ${String(e).slice(0, 160)}`); }
  });

  // existing keys (paginate past the 1000-row default)
  const existing = new Set<string>();
  for (let from = 0; ; from += 1000) {
    const rows = must(await ctx.db.from("provider_availability").select("provider, media_type, tmdb_id").range(from, from + 999), "load availability") as any[];
    for (const r of rows) existing.add(availabilityKey(r));
    if (rows.length < 1000) break;
  }
  const inserts = planSnapshotInserts({ seen, existingKeys: existing, previousCompleteStartedAt: prevComplete, now, runId: runRow.id });
  for (let i = 0; i < inserts.length; i += 500) {
    must(await ctx.db.from("provider_availability").upsert(inserts.slice(i, i + 500), { onConflict: "provider,media_type,tmdb_id,region", ignoreDuplicates: true }), "insert availability");
  }
  for (const { p, m } of jobs) {
    const ids = seen.filter((s) => s.provider === p && s.media_type === m && existing.has(availabilityKey(s))).map((s) => s.tmdb_id);
    if (ids.length) await ctx.db.rpc("radar_touch_availability", { p, m, ids, seen_at: now.toISOString() });
  }
  const stats = { pages, titles_seen: seen.length, new_titles: inserts.length, baseline: !prevComplete, tmdb_requests: tmdb.requests };
  await ctx.db.from("snapshot_runs").update({
    finished_at: new Date().toISOString(), complete, is_baseline: !prevComplete, pages_fetched: pages,
    titles_seen: seen.length, new_titles: inserts.length, error: errors.join("; ") || null,
  }).eq("id", runRow.id);
  await finishRun(ctx, pipeRun, complete ? "succeeded" : "partial", stats, { tmdb_snapshot: complete ? "ok" : errors.join("; ") });
  return { status: complete ? "succeeded" : "partial", ...stats, errors };
}

// ------------------------------------------------------------------ collect

interface TitleBucket {
  media_type: MediaType;
  tmdb_id: number;
  sa: SaChange[];
  snapshot: Map<Provider, SnapshotObservation>;
  claims: ArticleClaim[];
  original: boolean;
}

function bucketFor(map: Map<string, TitleBucket>, media: MediaType, id: number): TitleBucket {
  const k = `${media}:${id}`;
  let b = map.get(k);
  if (!b) { b = { media_type: media, tmdb_id: id, sa: [], snapshot: new Map(), claims: [], original: false }; map.set(k, b); }
  return b;
}

export async function runCollect(ctx: Ctx, w: TimeWindow, trigger: string, task = "collect") {
  const runId = await startRun(ctx, task, trigger, w);
  const health: Record<string, string> = {};
  const stats: Record<string, number> = {};
  const now = ctx.now();
  const cutoff = new Date(Math.min(now.getTime(), w.end.getTime()));
  const tmdb = new Tmdb(ctx.env.TMDB_READ_TOKEN, ctx.fetchImpl);
  const titles = new Map<string, TitleBucket>();
  let partial = false;
  const timings: Record<string, number> = {};
  const timed = async <T>(name: string, f: () => Promise<T>): Promise<T> => {
    const t0 = Date.now();
    try { return await f(); } finally { timings[name] = Date.now() - t0; }
  };
  try {
    const prefs = await loadPreferences(ctx);
    const newsSince = new Date(w.start.getTime() - 3 * DAY_MS);

    // 1. Fetch all sources in parallel
    const [sa, snapRes, orig, news] = await Promise.all([
      // 1a. Streaming Availability changes (primary date source when subscribed)
      timed("streaming_availability", () => fetchSaChanges({
        apiKey: ctx.env.RAPIDAPI_KEY, fromSec: Math.floor(w.start.getTime() / 1000), toSec: Math.floor(cutoff.getTime() / 1000), fetchImpl: ctx.fetchImpl,
      })),
      // 1b. Snapshot first-seen observations inside the window (fallback date source)
      timed("snapshot_obs", async () => {
        const snaps = must(await ctx.db.from("provider_availability").select("provider, media_type, tmdb_id, first_seen_at, added_after")
          .not("added_after", "is", null).gte("first_seen_at", w.start.toISOString()).lt("first_seen_at", cutoff.toISOString()).limit(2000), "load snapshot obs") as any[];
        const last = must(await ctx.db.from("snapshot_runs").select("started_at, complete").order("started_at", { ascending: false }).limit(1), "last snapshot") as any[];
        return { snaps, last: last[0] ?? null };
      }),
      // 1c. Platform originals with an episode airing in the window
      timed("tmdb_originals", () => tmdb.originalsAiring(istDate(w.start), istDate(new Date(cutoff.getTime() - 1)))),
      // 1d. News discovery (evidence only)
      timed("news", () => discoverNews({ since: newsSince, fetchImpl: ctx.fetchImpl })),
    ]);

    health.streaming_availability = sa.status === "ok" ? `ok (${sa.changes.length} changes, ${sa.requests} req${sa.reason ? `; ${sa.reason}` : ""})` : `${sa.status}: ${sa.reason}`;
    stats.sa_changes = sa.changes.length;
    for (const c of sa.changes) {
      let key = parseTmdbKey(c.tmdb_key);
      if (!key && c.title) {
        const res = await tmdb.search(c.title, c.show_type === "movie" ? "movie" : "tv");
        const m = pickMatch(c.title, res, normalizeTitle, Number(istDate(now).slice(0, 4)));
        if (m.match && !m.ambiguous) key = { media_type: m.match.media_type, id: m.match.id };
      }
      if (key) bucketFor(titles, key.media_type, key.id).sa.push(c);
    }

    const { snaps, last: lastSnap } = snapRes;
    for (const s of snaps) bucketFor(titles, s.media_type, s.tmdb_id).snapshot.set(s.provider, { provider: s.provider, first_seen_at: s.first_seen_at, added_after: s.added_after });
    health.snapshot = lastSnap ? `last ${lastSnap.started_at}${lastSnap.complete ? "" : " (incomplete)"}; ${snaps.length} first-seen in window` : "no snapshots yet (cold start)";
    if (!lastSnap || now.getTime() - Date.parse(lastSnap.started_at) > 2 * DAY_MS) health.snapshot_stale = "latest snapshot older than 48h";
    stats.snapshot_first_seen = snaps.length;

    for (const id of orig.ids) bucketFor(titles, "tv", id).original = true;
    health.tmdb_originals = `ok (${orig.ids.length})`;

    Object.assign(health, news.health);
    stats.news_items = news.items.length;

    // 2. Normalise news → Gemini extraction → TMDB match (evidence only)
    await timed("extraction", async () => {
      const srcRows = news.items.slice(0, 80).map((i) => ({
        kind: i.kind, url: i.url, title: i.title, publisher: i.publisher, published_at: i.published_at,
        snippet: (i.article_text ?? i.snippet).slice(0, 2000), query: i.query ?? null, last_checked_at: now.toISOString(),
      }));
      const saved = srcRows.length ? must(await ctx.db.from("sources").upsert(srcRows, { onConflict: "url" }).select("id, url"), "save sources") as any[] : [];
      const idByUrl = new Map(saved.map((s) => [s.url, s.id]));
      const urlById = new Map(saved.map((s) => [s.id, s.url]));
      const articles: ArticleInput[] = news.items.slice(0, 80)
        .filter((i) => idByUrl.has(i.url) && (i.article_text || /ott|netflix|prime|hotstar|stream|release/i.test(i.title)))
        .slice(0, 20).map((i) => ({ id: idByUrl.get(i.url), headline: i.title, publisher: i.publisher, published_at: i.published_at, text: i.article_text ?? i.snippet }));
      const g = geminiCfg(ctx.env);
      if (!articles.length || !g.apiKeys.length) {
        health.gemini_extraction = g.apiKeys.length ? "no OTT articles found" : "skipped (no GEMINI_API_KEY)";
        return;
      }
      if (timeLeft(ctx) < 70_000) { partial = true; health.gemini_extraction = "skipped: time budget"; return; }
      try {
        const ex = await extractCandidates(g, articles);
        health.gemini_extraction = `ok (${ex.candidates.length} candidates, ${ex.rejected} rejected as ungrounded)`;
        stats.candidates = ex.candidates.length;
        const art = new Map(articles.map((a) => [a.id, a]));
        const candRows: any[] = [];
        await mapLimit(ex.candidates.slice(0, 40), 6, async (c) => {
          const a = art.get(c.article_id)!;
          const res = await tmdb.search(c.title, c.media_type);
          const refYear = Number((a.published_at ?? now.toISOString()).slice(0, 4));
          const m = pickMatch(c.title, res, normalizeTitle, refYear);
          const status = !m.match ? "unmatched" : m.ambiguous ? "ambiguous" : "matched";
          candRows.push({
            run_id: runId, source_id: c.article_id, raw_title: c.title, stated_platform: c.platform, stated_release_date: c.stated_release_date,
            release_type_hint: c.release_type_hint, evidence_quote: c.evidence_quote, tmdb_id: m.match?.id ?? null,
            media_type: m.match?.media_type ?? null, match_confidence: m.confidence, match_status: status,
          });
          if (status !== "matched") return;
          bucketFor(titles, m.match!.media_type, m.match!.id).claims.push({
            source_id: c.article_id, url: urlById.get(c.article_id) ?? "", publisher: a.publisher,
            published_at: a.published_at, stated_platform: c.platform, stated_date: c.stated_release_date, quote: c.evidence_quote,
          });
        });
        if (candRows.length) await ctx.db.from("candidates").upsert(candRows, { onConflict: "source_id,raw_title" });
        stats.candidates_matched = candRows.filter((r) => r.match_status === "matched").length;
      } catch (e) {
        health.gemini_extraction = `failed: ${String(e).slice(0, 160)} — news discovery skipped this run`;
      }
    });

    // 3. Facts + verification per title
    stats.titles_considered = titles.size;
    const verified: { rows: VerifiedRelease[]; facts: TitleFacts }[] = [];
    await timed("verify", () => mapLimit([...titles.values()], 12, async (b) => {
      if (timeLeft(ctx) < 30_000) { partial = true; return; }
      try {
        const detail: any = await tmdb.titleFacts(b.media_type, b.tmdb_id);
        if (!detail) return;
        const originalOf = detail.networks.map((n: number) => TMDB_NETWORK_MAP[n]).filter(Boolean) as Provider[];
        let episodes: EpisodeAir[] = [];
        if (b.media_type === "tv" && (b.original || b.claims.length || b.sa.some((c) => c.item_type !== "show"))) {
          episodes = await tmdb.recentEpisodes(detail, b.tmdb_id);
        }
        const providers = new Set<Provider>([...b.sa.map((c) => c.provider), ...b.snapshot.keys(), ...originalOf]);
        for (const c of b.claims) {
          if (c.stated_platform && c.stated_platform !== "other") providers.add(c.stated_platform);
          else if (!c.stated_platform) detail.available_in.forEach((p: Provider) => providers.add(p));
        }
        const rows: VerifiedRelease[] = [];
        for (const p of providers) {
          rows.push(...verifyTitle({ facts: detail, provider: p, saChanges: b.sa, snapshot: b.snapshot.get(p) ?? null, episodes, claims: b.claims }, w, now));
        }
        if (rows.length) verified.push({ rows, facts: detail });
      } catch (e) {
        health[`title:${b.media_type}/${b.tmdb_id}`] = `error: ${String(e).slice(0, 100)}`;
      }
    }));
    stats.tmdb_requests = tmdb.requests;

    // 4. Deduplicate + save
    const saved = await timed("save", () => saveReleases(ctx, verified));
    Object.assign(stats, saved);

    // 5–6. Preference filter + recommendations for confirmed releases in the window
    if (timeLeft(ctx) > 25_000) {
      const r = await timed("recommend", () => ensureRecommendations(ctx, w, prefs));
      stats.recommended = r.created; stats.rec_fallbacks = r.fallbacks;
      health.gemini_recommendations = r.errors.length ? `degraded: ${r.errors.join("; ").slice(0, 200)}` : `ok (${r.created})`;
    } else { partial = true; health.gemini_recommendations = "skipped: time budget (will run at delivery)"; }
    for (const [k, v] of Object.entries(timings)) stats[`ms_${k}`] = v;

    await finishRun(ctx, runId, partial ? "partial" : "succeeded", stats, health);
    return { runId, status: partial ? "partial" : "succeeded", stats, health };
  } catch (e) {
    await finishRun(ctx, runId, "failed", stats, health, String(e));
    return { runId, status: "failed", stats, health, error: String(e) };
  }
}

const STATUS_RANK: Record<string, number> = { confirmed: 3, needs_review: 2, excluded: 1 };

async function saveReleases(ctx: Ctx, verified: { rows: VerifiedRelease[]; facts: TitleFacts }[]) {
  let inserted = 0, updated = 0, evidence = 0, confirmed = 0, review = 0, excluded = 0;
  await mapLimit(verified, 14, async ({ rows, facts }) => {
    const existing = must(await ctx.db.from("releases").select("id, media_type, tmdb_id, provider, release_type, season_number, episode_number, available_date, verification_status, date_basis, reviewed_at, confidence")
      .eq("media_type", facts.media_type).eq("tmdb_id", facts.tmdb_id), "load existing") as any[];
    for (const r of rows) {
      if (r.verification_status === "confirmed") confirmed++; else if (r.verification_status === "needs_review") review++; else excluded++;
      const meta = {
        title: facts.title, original_title: facts.original_title, original_language: facts.original_language,
        spoken_languages: facts.spoken_languages, genres: facts.genres, overview: facts.overview, poster_path: facts.poster_path,
        backdrop_path: facts.backdrop_path, year: facts.release_date ? Number(facts.release_date.slice(0, 4)) : null,
        runtime_min: facts.runtime_min ?? null, last_checked_at: new Date().toISOString(),
      };
      const match = existing.find((e) => identityKey(e) === identityKey(r) &&
        (!e.available_date || !r.available_date || Math.abs(daysBetween(e.available_date, r.available_date)) <= SAME_EVENT_DAYS));
      let id: string;
      let isNew = false;
      if (match) {
        id = match.id;
        const humanLocked = !!match.reviewed_at;
        const upgrade = !humanLocked && (STATUS_RANK[r.verification_status] > STATUS_RANK[match.verification_status] ||
          (r.verification_status === match.verification_status && r.confidence > Number(match.confidence)));
        const patch: any = { ...meta, watch_link: r.watch_link ?? undefined };
        if (upgrade) Object.assign(patch, {
          verification_status: r.verification_status, confidence: r.confidence, date_basis: r.date_basis, available_date: r.available_date,
          available_at: r.available_at, release_type: r.release_type, verification_notes: r.notes.join("\n") || null,
          episode_count: r.episode_count ?? null, dedupe_key: dedupeKey(r),
        });
        must(await ctx.db.from("releases").update(patch).eq("id", id), "update release");
        updated++;
      } else {
        const ins = must(await ctx.db.from("releases").upsert({
          ...meta, media_type: r.media_type, tmdb_id: r.tmdb_id, provider: r.provider, release_type: r.release_type,
          season_number: r.season_number, episode_number: r.episode_number, available_date: r.available_date, available_at: r.available_at,
          date_basis: r.date_basis, verification_status: r.verification_status, confidence: r.confidence,
          verification_notes: r.notes.join("\n") || null, watch_link: r.watch_link ?? null, episode_count: r.episode_count ?? null,
          dedupe_key: dedupeKey(r),
        }, { onConflict: "dedupe_key" }).select("id").single(), "insert release") as any;
        id = ins.id;
        existing.push({ ...r, id, confidence: r.confidence });
        inserted++;
        isNew = true;
      }
      // brand-new rows have no evidence yet → skip the lookup (saves a round trip per release)
      const have = isNew ? [] : must(await ctx.db.from("release_evidence").select("evidence_type, source_id, stated_date").eq("release_id", id), "load evidence") as any[];
      const k = (e: any) => `${e.evidence_type}|${e.source_id ?? ""}|${e.stated_date ?? ""}`;
      const seen = new Set(have.map(k));
      const fresh = r.evidence.filter((e) => { const kk = k(e); if (seen.has(kk)) return false; seen.add(kk); return true; })
        .map((e) => ({ release_id: id, evidence_type: e.evidence_type, stance: e.stance, source_id: e.source_id ?? null, url: e.url ?? null,
          stated_date: e.stated_date ?? null, stated_platform: e.stated_platform ?? null, quote: e.quote ?? null, detail: e.detail ?? {} }));
      if (fresh.length) {
        const ins = await ctx.db.from("release_evidence").insert(fresh);
        if (!ins.error) evidence += fresh.length; // a duplicate (unique index) is harmless; never fail the run for it
      }
    }
  });
  return { releases_inserted: inserted, releases_updated: updated, evidence_added: evidence, confirmed, needs_review: review, excluded };
}

// ------------------------------------------------------------------ recommendations & digest data

export function releaseInWindow(r: { available_at: string | null; available_date: string | null }, w: TimeWindow): boolean {
  if (r.available_at) return inWindow(new Date(r.available_at), w);
  return !!r.available_date && dateInWindow(r.available_date, w);
}

/**
 * Hard language filter on TMDB's ORIGINAL language (e.g. a Polish film that merely lists English among spoken languages
 * does not count). Dubs/audio tracks are not exposed by TMDB, so they are never assumed.
 */
export function matchesLanguage(r: { original_language?: string | null }, languages: string[]): boolean {
  if (!languages.length) return true;
  return !!r.original_language && languages.includes(r.original_language);
}

export function passesPreferences(r: any, prefs: Preferences): boolean {
  if (!prefs.platforms.includes(r.provider)) return false;
  if (!prefs.media_types.includes(r.media_type)) return false;
  if (!matchesLanguage(r, prefs.languages)) return false;
  if (r.release_type === "older_addition") return prefs.include_older_additions;
  return prefs.release_types.includes(r.release_type);
}

export async function windowReleases(ctx: Ctx, w: TimeWindow, status = "confirmed") {
  const rows = must(await ctx.db.from("releases")
    .select("*, recommendations(*), release_evidence(url, evidence_type, stance)")
    .eq("verification_status", status)
    .gte("available_date", istDate(new Date(w.start.getTime() - DAY_MS)))
    .lte("available_date", istDate(w.end)), "window releases") as any[];
  return rows.filter((r) => releaseInWindow(r, w));
}

export async function ensureRecommendations(ctx: Ctx, w: TimeWindow, prefs: Preferences & { hash: string }) {
  const rows = (await windowReleases(ctx, w)).filter((r) => passesPreferences(r, prefs));
  const missing = rows.filter((r) => !(r.recommendations ?? []).some((x: any) => x.preferences_hash === prefs.hash));
  if (!missing.length) return { created: 0, fallbacks: 0, errors: [] as string[] };
  // One opinion per show/title per provider: every episode row of a daily show shares it (saves Gemini quota).
  const showKey = (r: any) => `${r.media_type}:${r.tmdb_id}:${r.provider}`;
  const existingByShow = new Map<string, any>();
  for (const r of rows) {
    const rec = (r.recommendations ?? []).find((x: any) => x.preferences_hash === prefs.hash);
    if (rec) existingByShow.set(showKey(r), rec);
  }
  const groups = new Map<string, any[]>();
  for (const r of missing) groups.set(showKey(r), [...(groups.get(showKey(r)) ?? []), r]);
  const toAsk = [...groups.entries()].filter(([k]) => !existingByShow.has(k)).map(([, g]) => g[0]);
  const inputs: RecInput[] = toAsk.map((r) => ({
    release_id: r.id, title: r.title, media_type: r.media_type, provider: r.provider, release_type: r.release_type,
    genres: r.genres, original_language: r.original_language, spoken_languages: r.spoken_languages, runtime_min: r.runtime_min,
    episode_count: r.episode_count, overview: r.overview,
  }));
  const g = geminiCfg(ctx.env);
  const out = inputs.length ? await recommend(g, prefs, inputs) : { recs: [], fallbackCount: 0, errors: [] as string[] };
  const byShow = new Map<string, any>(existingByShow);
  for (const x of out.recs) {
    const r = toAsk.find((t) => t.id === x.release_id);
    if (r) byShow.set(showKey(r), x);
  }
  const recs = missing.filter((r) => byShow.has(showKey(r))).map((r) => {
    const x = byShow.get(showKey(r));
    return {
      release_id: r.id, preferences_hash: prefs.hash, verdict: x.verdict, score: x.score,
      reason: String(x.reason).slice(0, 280), synopsis: String(x.synopsis).slice(0, 320), model: x.model, is_fallback: x.is_fallback,
    };
  });
  must(await ctx.db.from("recommendations").upsert(recs, { onConflict: "release_id,preferences_hash" }), "save recommendations");
  return { created: recs.length, fallbacks: out.fallbackCount, errors: out.errors };
}

export async function buildDigest(ctx: Ctx, w: TimeWindow, isTest: boolean, degraded: string[] = []) {
  const prefs = await loadPreferences(ctx);
  await ensureRecommendations(ctx, w, prefs);
  const rows = (await windowReleases(ctx, w)).filter((r) => passesPreferences(r, prefs));
  const reviewRows = (await windowReleases(ctx, w, "needs_review")).length;
  // Releases already delivered in an earlier real digest (for the 🆕 marker when digests overlap).
  const prior = must(await ctx.db.from("digest_runs").select("id").eq("is_test", false).eq("status", "sent").neq("window_key", w.key)
    .gte("created_at", new Date(w.start.getTime() - DAY_MS).toISOString()), "prior digests") as any[];
  const seenIds = new Set<string>();
  if (prior.length) {
    const di = must(await ctx.db.from("digest_items").select("release_id").in("digest_run_id", prior.map((p) => p.id)), "prior items") as any[];
    for (const x of di) seenIds.add(x.release_id);
  }
  const items: DigestRelease[] = rows.map((r) => {
    const rec = (r.recommendations ?? []).find((x: any) => x.preferences_hash === prefs.hash) ?? null;
    const ev = (r.release_evidence ?? []).find((e: any) => e.stance === "supports" && e.url && e.evidence_type !== "availability_current");
    return {
      id: r.id, title: r.title, year: r.year, media_type: r.media_type, provider: r.provider, release_type: r.release_type,
      season_number: r.season_number, episode_number: r.episode_number, episode_count: r.episode_count, available_date: r.available_date,
      available_at: r.available_at, date_basis: r.date_basis, genres: r.genres, original_language: r.original_language,
      runtime_min: r.runtime_min, watch_link: r.watch_link, evidence_url: ev?.url ?? null,
      is_new: prior.length ? !seenIds.has(r.id) : undefined,
      rec: rec ? { verdict: rec.verdict, score: rec.score, reason: rec.reason, synopsis: rec.synopsis, is_fallback: rec.is_fallback } : null,
    };
  });
  const { blocks, sections } = buildDigestBlocks({
    window: w, items, includeOlder: prefs.include_older_additions, reviewCount: reviewRows,
    dashboardUrl: ctx.env.DASHBOARD_URL || null, isTest, degradedSources: degraded,
  });
  return { chunks: chunkBlocks(blocks), sections, items, recIds: new Map(rows.map((r) => [r.id, (r.recommendations ?? []).find((x: any) => x.preferences_hash === prefs.hash)?.id ?? null])) };
}

// ------------------------------------------------------------------ deliver

class DbDeliveryStore implements DeliveryStore {
  constructor(private db: any, private runId: string, private chatRef: string) {}
  private q() { return this.db.from("delivery_logs"); }
  async get(i: number) {
    const r = must(await this.q().select("status, attempts").eq("digest_run_id", this.runId).eq("chunk_index", i).eq("chat_ref", this.chatRef).maybeSingle(), "delivery get") as any;
    return r ? { status: r.status, attempts: r.attempts } : null;
  }
  async begin(i: number) {
    const cur = await this.get(i);
    if (!cur) {
      const r = await this.q().insert({ digest_run_id: this.runId, chunk_index: i, chat_ref: this.chatRef, status: "sending", attempts: 1 });
      return !r.error; // unique violation → another worker owns this chunk
    }
    if (cur.status !== "failed") return false;
    const r = must(await this.q().update({ status: "sending", attempts: cur.attempts + 1 })
      .eq("digest_run_id", this.runId).eq("chunk_index", i).eq("chat_ref", this.chatRef).eq("status", "failed").select("id"), "delivery begin") as any[];
    return r.length === 1;
  }
  private async set(i: number, patch: any) {
    must(await this.q().update(patch).eq("digest_run_id", this.runId).eq("chunk_index", i).eq("chat_ref", this.chatRef), "delivery update");
  }
  markSent(i: number, messageId: number) { return this.set(i, { status: "sent", telegram_message_id: messageId, error: null, http_status: 200 }); }
  markFailed(i: number, error: string, httpStatus: number | null) { return this.set(i, { status: "failed", error, http_status: httpStatus }); }
  markUnknown(i: number, error: string) { return this.set(i, { status: "unknown", error }); }
}

export async function runDeliver(ctx: Ctx, w: TimeWindow, o: { isTest: boolean; trigger: string; degraded?: string[] }) {
  const runId = await startRun(ctx, o.isTest ? "test_send" : "deliver", o.trigger, w);
  try {
    const token = ctx.env.TELEGRAM_BOT_TOKEN, chat = ctx.env.TELEGRAM_CHAT_ID;
    let digest: any;
    if (!o.isTest) {
      digest = (must(await ctx.db.from("digest_runs").select("*").eq("window_key", w.key).eq("is_test", false).limit(1), "load digest") as any[])[0];
      if (digest?.status === "sent") { await finishRun(ctx, runId, "skipped", { reason: "already sent" }, {}); return { status: "skipped", reason: "already sent", digestRunId: digest.id }; }
      if (digest?.status === "needs_attention") {
        await finishRun(ctx, runId, "skipped", { reason: "needs attention (possible partial send) — not resending" }, {});
        return { status: "skipped", reason: "needs_attention", digestRunId: digest.id };
      }
    } else {
      const recent = must(await ctx.db.from("digest_runs").select("created_at").eq("is_test", true).gte("created_at", new Date(Date.now() - 120_000).toISOString()).limit(1), "recent test") as any[];
      if (recent.length) { await finishRun(ctx, runId, "skipped", { reason: "test send throttled (2 min)" }, {}); return { status: "skipped", reason: "A test was sent less than 2 minutes ago." }; }
    }
    if (!digest) {
      const built = await buildDigest(ctx, w, o.isTest, o.degraded ?? []);
      const ins = await ctx.db.from("digest_runs").insert({
        window_key: w.key, window_start: w.start.toISOString(), window_end: w.end.toISOString(), is_test: o.isTest,
        status: "built", chunk_count: built.chunks.length, chunks: built.chunks, item_count: built.items.length,
      }).select("*").single();
      if (ins.error) {
        // concurrent scheduled run created it first (unique per window) → use theirs
        digest = (must(await ctx.db.from("digest_runs").select("*").eq("window_key", w.key).eq("is_test", false).limit(1), "reload digest") as any[])[0];
        if (!digest) throw new Error(ins.error.message);
      } else {
        digest = ins.data;
        const items = built.sections.map((s, i) => ({ digest_run_id: digest.id, release_id: s.id, section: s.section, position: i, recommendation_id: built.recIds.get(s.id) ?? null }));
        if (items.length) await ctx.db.from("digest_items").insert(items);
      }
    }
    const liveOk = (ctx.env.LIVE_SEND_ENABLED ?? "").toLowerCase() === "true";
    if (!o.isTest && !liveOk) {
      await finishRun(ctx, runId, "skipped", { reason: "LIVE_SEND_ENABLED is not true — digest built, not sent", digest_run_id: digest.id }, {});
      return { status: "skipped", reason: "live sending disabled", digestRunId: digest.id };
    }
    if (!token || !chat) throw new Error("TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID not configured");
    await ctx.db.from("digest_runs").update({ status: "sending" }).eq("id", digest.id);
    const store = new DbDeliveryStore(ctx.db, digest.id, await sha256Prefix(chat));
    const res = await sendChunks({ token, chatId: chat, chunks: digest.chunks, store, fetchImpl: ctx.fetchImpl });
    await ctx.db.from("digest_runs").update({
      status: res.status, sent_at: res.status === "sent" ? new Date().toISOString() : null, error: res.errors.join("; ") || null,
    }).eq("id", digest.id);
    await finishRun(ctx, runId, res.status === "sent" ? "succeeded" : res.status === "partial" ? "partial" : "failed",
      { ...res, digest_run_id: digest.id }, { telegram: res.status }, res.errors.join("; ") || undefined);
    return { status: res.status, digestRunId: digest.id, result: res };
  } catch (e) {
    await finishRun(ctx, runId, "failed", {}, {}, String(e));
    return { status: "failed", error: String(e) };
  }
}

// ------------------------------------------------------------------ weekly (cron)

export const WEEKLY_GRACE_MS = 3 * 60 * 60 * 1000;

export async function runWeekly(ctx: Ctx, trigger: string) {
  const now = ctx.now();
  const w = digestWindowFor(now);
  if (now.getTime() - w.end.getTime() > WEEKLY_GRACE_MS) {
    return { status: "skipped", reason: `outside the Friday send window (window ${w.key})` };
  }
  return runScheduledDigest(ctx, trigger, w);
}

/** Owner-requested extra digest at 18:30 IST today: rolling 7 days ending at today's 18:30 IST, one per day (key adhoc-YYYY-MM-DD). */
export function adhocWindowFor(now: Date): TimeWindow | null {
  const end = new Date(Date.parse(`${istDate(now)}T13:00:00Z`)); // 18:30 IST of today's IST date
  if (now.getTime() < end.getTime() - 5 * 60_000 || now.getTime() - end.getTime() > WEEKLY_GRACE_MS) return null;
  return { start: new Date(end.getTime() - 7 * DAY_MS), end, key: `adhoc-${istDate(end)}` };
}

export async function runAdhoc(ctx: Ctx, trigger: string) {
  const w = adhocWindowFor(ctx.now());
  if (!w) return { status: "skipped", reason: "not within an 18:30 IST send slot" };
  return runScheduledDigest(ctx, trigger, w);
}

async function runScheduledDigest(ctx: Ctx, trigger: string, w: TimeWindow) {
  const now = ctx.now();
  const prefs = await loadPreferences(ctx);
  if (!prefs.digest_enabled) return { status: "skipped", reason: "digest disabled in preferences" };
  const sent = must(await ctx.db.from("digest_runs").select("status").eq("window_key", w.key).eq("is_test", false).limit(1), "digest state") as any[];
  if (sent[0]?.status === "sent") return { status: "skipped", reason: "digest already sent for this window", window: w.key };
  const runs = must(await ctx.db.from("pipeline_runs").select("status, source_health, started_at").eq("task", "collect").eq("window_key", w.key)
    .order("started_at", { ascending: false }), "load collect runs") as any[];
  if (runs[0]?.status === "running" && now.getTime() - Date.parse(runs[0].started_at) < 4 * 60_000) {
    return { status: "skipped", reason: "a collect run is already in progress", window: w.key };
  }
  // Runs killed by the platform time limit stay 'running' — they still count as attempts.
  let collect = runs.find((r) => r.status === "succeeded") ?? null;
  if (!collect && runs.length < 4) {
    const c = await runCollect(ctx, w, trigger);
    collect = { status: c.status, source_health: c.health };
  } else if (!collect) collect = runs.find((r) => r.status === "partial") ?? runs[0];
  if (!collect || !["succeeded", "partial"].includes(collect.status)) {
    return { status: "failed", reason: "collection failed; will retry at the next scheduled attempt", window: w.key };
  }
  const degraded = Object.entries(collect.source_health ?? {})
    .filter(([k, v]) => /^(streaming_availability|snapshot_stale|gemini)/.test(k) && !/^ok/.test(String(v)))
    .map(([k]) => k === "streaming_availability" ? "Streaming Availability unavailable — dates from India snapshot diff" :
      k === "snapshot_stale" ? "availability snapshot is stale" : "AI partly unavailable — rule-based opinions used");
  if (timeLeft(ctx) < 45_000) {
    // Not enough wall-clock left to deliver safely in this invocation → the entrypoint re-invokes with a fresh budget.
    return { status: "deferred", reason: "delivery handed to a fresh invocation", window: w.key, collect: collect.status };
  }
  const d = await runDeliver(ctx, w, { isTest: false, trigger, degraded });
  return { window: w.key, collect: collect.status, deliver: d };
}

export { digestWindowFor, upcomingWindow };
