// LIVE smoke test of the real pipeline code under Node (not mocks): collect for the upcoming window + digest preview.
// Never sends Telegram messages (no deliver step is called). Prints per-host request timings, never secrets.
// Usage: node --experimental-transform-types scripts/live-smoke.mjs [collect|preview]
import { createClient } from "@supabase/supabase-js";
import { buildDigest, runCollect, upcomingWindow } from "../supabase/functions/_shared/pipeline.ts";

process.loadEnvFile(".env");
const E = process.env;
const mode = process.argv[2] ?? "collect";

const perHost = new Map();
const timedFetch = async (url, init) => {
  if (String(url).includes("api.telegram.org")) throw new Error("live-smoke must never call Telegram");
  const host = new URL(String(url)).host;
  const t0 = Date.now();
  try { return await fetch(url, init); }
  finally {
    const h = perHost.get(host) ?? { n: 0, ms: 0, max: 0 };
    const d = Date.now() - t0;
    perHost.set(host, { n: h.n + 1, ms: h.ms + d, max: Math.max(h.max, d) });
  }
};

const db = createClient(E.SUPABASE_URL, E.SUPABASE_SECRET_KEY, { auth: { persistSession: false }, global: { fetch: timedFetch } });
const ctx = {
  db, now: () => new Date(), deadline: Date.now() + 120_000, fetchImpl: timedFetch,
  env: {
    TMDB_READ_TOKEN: E.TMDB_READ_TOKEN, RAPIDAPI_KEY: E.RAPIDAPI_KEY, GEMINI_API_KEY: E.GEMINI_API_KEY,
    GEMINI_API_KEY_FALLBACK: E.GEMINI_API_KEY_FALLBACK, GEMINI_MODEL: E.GEMINI_MODEL, DASHBOARD_URL: E.DASHBOARD_URL,
  },
};
const w = upcomingWindow(new Date());
const t0 = Date.now();
const out = mode === "preview" ? await buildDigest(ctx, w, false).then((d) => ({ items: d.items.length, chunks: d.chunks })) : await runCollect(ctx, w, "manual", "manual_collect");
console.log(JSON.stringify(out, null, 1).slice(0, 12000));
console.log(`\nTotal ${((Date.now() - t0) / 1000).toFixed(1)}s`);
for (const [h, v] of [...perHost].sort((a, b) => b[1].ms - a[1].ms)) console.log(h.padEnd(48), `${v.n} req`, `${(v.ms / 1000).toFixed(1)}s total`, `max ${(v.max / 1000).toFixed(1)}s`);
