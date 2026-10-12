# Source feasibility — India OTT launch-date verification

Probe: `node scripts/feasibility.mjs` (read-only; never prints secrets; never sends Telegram messages).
Run: **2026-10-12** (IST). Raw responses saved locally to `scripts/out/` (gitignored).

## Results (live, not mocked)

| Source | What we called | Result | What it actually exposes |
|---|---|---|---|
| TMDB v3 | `/configuration`, `/watch/providers/{movie,tv}?watch_region=IN`, `/discover/{movie,tv}`, `/movie/{id}/watch/providers`, `/movie/{id}/release_dates`, `/tv/{id}` | **200** | Metadata, posters, genres, runtime, seasons/episodes, `air_date` per episode. India provider IDs: **Netflix 8, Amazon Prime Video 119, JioHotstar 2336** (+ Netflix Kids 175, Prime with Ads 2100). |
| TMDB watch providers (data by JustWatch) | `/movie/{id}/watch/providers` → `results.IN` | **200** | Keys: `link`, `flatrate` (also `rent`/`buy`/`ads`/`free` when present). Entry keys: `logo_path, provider_id, provider_name, display_priority`. **No date field of any kind.** Proves *current* availability only. Requires JustWatch attribution. |
| TMDB release dates | `/movie/{id}/release_dates` → `IN` | **200** | Example: `type: 4 (Digital)`, `note: "Netflix"`, `release_date: 2026-10-09`. `note` is free text entered by the community. **Not accepted as OTT launch proof** (per spec); usable only as corroborating evidence. |
| Streaming Availability API (Movie of the Night) via RapidAPI | `/countries/in`, `/changes?country=in&change_type=new&item_type=show\|episode&catalogs=netflix,prime,hotstar` | **403 "You are not subscribed to this API"**, then **429** | Per docs: `/changes` returns `changeType, itemType, showId, showType, service, streamingOptionType, season, episode, timestamp, link` per country and catalog; past changes always carry `timestamp`; window ≤ 31 days. **This is the only candidate found that states a per-country, per-service "added on" timestamp.** India coverage and the JioHotstar service ID are **unverified until a live call succeeds**. |
| Google News RSS (`news.google.com/rss/search`, `gl=IN`) | "OTT releases this week India" | **200, 100 items** | `title`, `link`, `pubDate`, `source` (publisher), `description` snippet. Recent publishers: Vogue India, GQ India, Economic Times, News18, Moneycontrol. **Discovery evidence only.** Publication date ≠ release date. |
| Gemini API | `GET /v1beta/models` | key #1 **401**, keys #2 and #3 **200** | `gemini-2.5-flash`, `gemini-3.5-flash`, `gemini-flash-latest` available. Key #1 was dropped from `.env`. |
| Telegram Bot API | `getMe`, `getChat`, `getChatMember` (**no sendMessage**) | **200** | Bot `@Namanscontentbot`; target is a **channel** ("Naman Channel"); bot is `administrator` with `can_post_messages: true`. |
| Supabase | `GET /rest/v1/` | secret **200**, publishable 401 (expected for root) | Empty project, no tables. **The REST API can't run migrations or deploy Edge Functions.** That needs either a Supabase personal access token (CLI) or the DB password. |

## Streaming Availability pricing (from movieofthenight.com/about/api/pricing)

Free plan: 1,000 requests/month; FAQ says all plans including Free allow commercial use; the quota is a hard limit with no overage.
Starter $49/mo for 25k requests. The RapidAPI listing has its own plans; your key isn't subscribed to any of them.
Estimated need for 1 user: about 3 item types × 1–4 pages × (weekly run + 1 mid-week refresh) plus about 20 detail lookups per week, which comes to **~150–250 requests/month** and fits the Free plan.

## Verification options

1. **Primary (needs your action): Streaming Availability `/changes`.** A change of type `new` with a timestamp inside the IST window, for catalog netflix/prime/hotstar in country `in`, counts as launch evidence. It's then cross-checked against TMDB/JustWatch `IN` availability.
2. **Fallback (needs your approval): TMDB/JustWatch snapshot diff.** We snapshot India availability for the 3 providers daily. A title that is absent on day N−1 and present on day N gets "first observed available in India" = day N.
   - Limitations: ±1-day precision; JustWatch sync lag (can be 1–3 days); **cold start**: anything added before the first snapshot can't be dated; the date is our observation, not an official launch date.
   - For new episodes of platform originals (TMDB network = Netflix/Amazon/JioHotstar), TMDB `air_date` plus current IN availability is used, with the label "episode air date (TMDB)".
3. **Never sufficient alone:** news articles, TMDB `release_dates` notes, Gemini extraction. Candidates supported only by these go to **Needs review**, never to confirmed results.

## Update — findings during build (2026-10-12, live)

| Finding | Evidence | Action taken |
|---|---|---|
| Gemini `gemini-2.5-flash` / `-lite` retired for new users | `generateContent` → HTTP 404 "no longer available to new users" | Default `gemini-3.1-flash-lite` (≈1 s), automatic fallback `gemini-3.8-flash`; both verified with live calls |
| `gemini-3.8-flash` too slow for extraction | 30-article extraction took **173 s** (profiled with `scripts/live-smoke.mjs`) — over the 150 s Edge limit (run killed: `WORKER_RESOURCE_LIMIT`) | Lite model, ≤ 20 articles × 2 500 chars, 50 s total Gemini budget → collect now **31 s** on Edge |
| Google News RSS blocks Supabase Edge IPs | 5/5 queries HTTP 503 from Edge; 200 from a residential IP | Kept (recorded per run in `source_health`) + 5 more publisher feeds (News18, The Hindu, Koimoi, Pinkvilla, NDTV) |
| TMDB episode air dates can be in the future | Daily shows had scheduled dates up to 16 Oct inside the open window on 12 Oct | Verification capped at "now"; 26 wrongly confirmed rows deleted; regression test |
| Snapshot fallback cold start | Baseline 1,447 titles (Netflix/Prime/JioHotstar, released ≤ 365 days) on 2026-10-12; complete run in 16 s | Additions are datable from the next snapshot (daily 06:00 IST + Fri 18:15 IST) |
| Streaming Availability still unsubscribed | Re-tested after the owner's choice: `/countries/in` → 403 | Pipeline treats it as `unavailable`; activates automatically once the free plan is subscribed |
