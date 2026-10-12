// Read-only feasibility probe. Never prints secrets. Never sends Telegram messages.
// Usage: node scripts/feasibility.mjs
import { mkdirSync, writeFileSync } from "node:fs";

process.loadEnvFile(".env");
const E = process.env;
mkdirSync("scripts/out", { recursive: true });
const save = (name, data) =>
  writeFileSync(`scripts/out/${name}.json`, JSON.stringify(data, null, 2));

const now = new Date();
const daysAgo = (d) => new Date(now.getTime() - d * 86400e3);
const ymd = (d) => d.toISOString().slice(0, 10);

async function get(url, headers = {}) {
  const t0 = Date.now();
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(20000) });
    const text = await r.text();
    let body;
    try { body = JSON.parse(text); } catch { body = text; }
    return { status: r.status, ms: Date.now() - t0, headers: r.headers, body };
  } catch (e) {
    return { status: 0, ms: Date.now() - t0, error: String(e) };
  }
}

const report = {};

// ---------- TMDB ----------
{
  const H = { Authorization: `Bearer ${E.TMDB_READ_TOKEN}`, accept: "application/json" };
  const T = "https://api.themoviedb.org/3";
  const cfg = await get(`${T}/configuration`, H);
  const mp = await get(`${T}/watch/providers/movie?watch_region=IN`, H);
  const tp = await get(`${T}/watch/providers/tv?watch_region=IN`, H);
  save("tmdb_providers_movie_IN", mp.body);
  save("tmdb_providers_tv_IN", tp.body);
  const want = /netflix|amazon prime|prime video|hotstar|jio/i;
  const pick = (b) => (b?.results || []).filter((p) => want.test(p.provider_name))
    .map((p) => ({ id: p.provider_id, name: p.provider_name, prio_IN: p.display_priorities?.IN }));
  const ids = pick(mp.body);

  // Discover movies currently on target providers in IN, newest first
  const provIds = ids.map((p) => p.id).join("|");
  const disc = await get(`${T}/discover/movie?watch_region=IN&with_watch_providers=${provIds}` +
    `&with_watch_monetization_types=flatrate&sort_by=primary_release_date.desc` +
    `&primary_release_date.lte=${ymd(now)}&page=1`, H);
  save("tmdb_discover_movie_IN", disc.body);
  const sample = disc.body?.results?.[0];
  let wp, rd, tvWp, tvDetail;
  if (sample) {
    wp = await get(`${T}/movie/${sample.id}/watch/providers`, H);
    rd = await get(`${T}/movie/${sample.id}/release_dates`, H);
    save("tmdb_sample_watch_providers", wp.body);
    save("tmdb_sample_release_dates", rd.body);
  }
  const discTv = await get(`${T}/discover/tv?watch_region=IN&with_watch_providers=${provIds}` +
    `&with_watch_monetization_types=flatrate&air_date.gte=${ymd(daysAgo(7))}&air_date.lte=${ymd(now)}` +
    `&sort_by=popularity.desc`, H);
  save("tmdb_discover_tv_IN_airing7d", discTv.body);
  const tvSample = discTv.body?.results?.[0];
  if (tvSample) {
    tvDetail = await get(`${T}/tv/${tvSample.id}`, H);
    tvWp = await get(`${T}/tv/${tvSample.id}/watch/providers`, H);
    save("tmdb_tv_sample_detail", tvDetail.body);
    save("tmdb_tv_sample_watch_providers", tvWp.body);
  }
  const inBlock = wp?.body?.results?.IN;
  report.tmdb = {
    auth: cfg.status,
    target_providers_IN: ids,
    discover_movie: { status: disc.status, total: disc.body?.total_results,
      first5: disc.body?.results?.slice(0, 5).map((m) => `${m.title} (${m.release_date}) #${m.id}`) },
    sample_watch_providers_IN_keys: inBlock ? Object.keys(inBlock) : null,
    sample_watch_providers_IN_flatrate_entry_keys: inBlock?.flatrate?.[0] ? Object.keys(inBlock.flatrate[0]) : null,
    sample_release_dates_IN: rd?.body?.results?.find((x) => x.iso_3166_1 === "IN")?.release_dates ?? "none",
    discover_tv_airing_7d: { status: discTv.status, total: discTv.body?.total_results,
      first5: discTv.body?.results?.slice(0, 5).map((s) => `${s.name} #${s.id}`) },
    tv_sample: tvDetail?.body ? {
      name: tvDetail.body.name,
      networks: tvDetail.body.networks?.map((n) => `${n.name}#${n.id}`),
      last_episode_to_air: tvDetail.body.last_episode_to_air &&
        { air_date: tvDetail.body.last_episode_to_air.air_date, s: tvDetail.body.last_episode_to_air.season_number, e: tvDetail.body.last_episode_to_air.episode_number },
      IN_provider_keys: tvWp?.body?.results?.IN ? Object.keys(tvWp.body.results.IN) : null,
    } : null,
  };
}

// ---------- RapidAPI: Streaming Availability (Movie of the Night) ----------
{
  const host = "streaming-availability.p.rapidapi.com";
  const H = { "x-rapidapi-key": E.RAPIDAPI_KEY, "x-rapidapi-host": host };
  const c = await get(`https://${host}/countries/in`, H);
  save("sa_country_in", c.body);
  const rl = (r) => r?.headers ? Object.fromEntries([...r.headers].filter(([k]) => /ratelimit|x-rapidapi/i.test(k) && !/key|proxy-secret/i.test(k))) : null;
  const from = Math.floor(daysAgo(7).getTime() / 1000);
  const ch = await get(`https://${host}/changes?country=in&change_type=new&item_type=show` +
    `&catalogs=netflix,prime,hotstar&from=${from}&include_unknown_dates=false`, H);
  save("sa_changes_in_new", ch.body);
  const chEp = await get(`https://${host}/changes?country=in&change_type=new&item_type=episode` +
    `&catalogs=netflix,prime,hotstar&from=${from}`, H);
  save("sa_changes_in_new_episode", chEp.body);
  report.streaming_availability = {
    country_status: c.status,
    country_error: c.status !== 200 ? (typeof c.body === "string" ? c.body.slice(0, 300) : c.body) : undefined,
    services_in: c.body?.services?.map((s) => `${s.id}:${s.name} [${Object.keys(s.streamingOptionTypes || {}).filter((k) => s.streamingOptionTypes[k]).join(",")}]`),
    changes_status: ch.status,
    changes_error: ch.status !== 200 ? (typeof ch.body === "string" ? ch.body.slice(0, 300) : ch.body) : undefined,
    changes_count: ch.body?.changes?.length,
    change_entry_keys: ch.body?.changes?.[0] ? Object.keys(ch.body.changes[0]) : null,
    changes_sample: ch.body?.changes?.slice(0, 8).map((x) => ({
      type: x.changeType, item: x.itemType, svc: x.service?.id, show: ch.body.shows?.[x.showId]?.title,
      showType: x.showType, ts: x.timestamp ? new Date(x.timestamp * 1000).toISOString() : x.timestamp,
      season: x.season, episode: x.episode,
    })),
    episode_changes_status: chEp.status, episode_changes_count: chEp.body?.changes?.length,
    rate_headers: rl(ch),
  };
}

// ---------- Google News RSS ----------
{
  const q = encodeURIComponent("OTT releases this week India");
  const r = await get(`https://news.google.com/rss/search?q=${q}&hl=en-IN&gl=IN&ceid=IN:en`, { "user-agent": "Mozilla/5.0 OTTReleaseRadar/0.1" });
  const items = typeof r.body === "string" ? [...r.body.matchAll(/<item>([\s\S]*?)<\/item>/g)].map((m) => m[1]) : [];
  const tag = (s, t) => (s.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`)) || [])[1];
  report.google_news_rss = {
    status: r.status, items: items.length,
    first5: items.slice(0, 5).map((it) => ({ title: tag(it, "title")?.slice(0, 120), pubDate: tag(it, "pubDate"), source: tag(it, "source"), has_description: !!tag(it, "description") })),
  };
}

// ---------- Gemini ----------
{
  report.gemini = {};
  for (const k of ["GEMINI_API_KEY", "GEMINI_API_KEY_2", "GEMINI_API_KEY_3"]) {
    const r = await get("https://generativelanguage.googleapis.com/v1beta/models?pageSize=200", { "x-goog-api-key": E[k] });
    report.gemini[k] = {
      status: r.status,
      error: r.status !== 200 ? r.body?.error?.message?.slice(0, 200) : undefined,
      flash_models: r.body?.models?.map((m) => m.name).filter((n) => /flash/i.test(n)).slice(0, 15),
    };
  }
}

// ---------- Telegram (read-only: getMe, getChat — NO sendMessage) ----------
{
  const B = `https://api.telegram.org/bot${E.TELEGRAM_BOT_TOKEN}`;
  const me = await get(`${B}/getMe`);
  const chat = await get(`${B}/getChat?chat_id=${encodeURIComponent(E.TELEGRAM_CHAT_ID)}`);
  report.telegram = {
    getMe: me.status, bot_username: me.body?.result?.username,
    getChat: chat.status, chat_type: chat.body?.result?.type, chat_title: chat.body?.result?.title,
    chat_error: chat.body?.ok === false ? chat.body.description : undefined,
  };
}

// ---------- Supabase ----------
{
  const pub = await get(`${E.SUPABASE_URL}/rest/v1/`, { apikey: E.SUPABASE_PUBLISHABLE_KEY });
  const sec = await get(`${E.SUPABASE_URL}/rest/v1/`, { apikey: E.SUPABASE_SECRET_KEY });
  report.supabase = {
    rest_publishable: pub.status, rest_secret: sec.status,
    exposed_tables: sec.body?.paths ? Object.keys(sec.body.paths).filter((p) => p !== "/") : (typeof sec.body === "object" ? sec.body?.message : null),
  };
}

save("_report", report);
console.log(JSON.stringify(report, null, 2));
