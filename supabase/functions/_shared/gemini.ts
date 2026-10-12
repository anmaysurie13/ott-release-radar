// Gemini (server-side only). Two jobs:
//  1. extractCandidates — pull title/platform/stated date + verbatim evidence quote out of news articles (discovery only)
//  2. recommend        — opinion: Watch/Maybe/Skip, 0–100 score, personal reason, 2-line synopsis from the TMDB overview
// Every response is schema-validated; anything invalid falls back to deterministic rules. Gemini never decides
// availability, dates or languages — those come from verified sources and are passed in as read-only facts.
import { type FetchLike, fetchWithRetry, redactUrl } from "./http.ts";
import { normalizeTitle } from "./dedupe.ts";
import { type MediaType, type Preferences, type Provider, PROVIDER_LABEL, type ReleaseType, type Verdict } from "./types.ts";

// Verified live 2026-10-12: gemini-2.5-* return 404 "no longer available to new users"; 3.8-flash and 3.1-flash-lite respond.
// Profiling showed 3.8-flash needs ~170 s for a 30-article extraction (it reasons at length) — far over the Edge
// Function budget — so the fast lite model is the default and 3.8-flash is only a fallback.
export const DEFAULT_MODEL = "gemini-3.1-flash-lite";
export const DEFAULT_FALLBACK_MODEL = "gemini-3.8-flash";
const API = "https://generativelanguage.googleapis.com/v1beta/models";

export interface GeminiConfig {
  apiKeys: string[];      // primary first; fallbacks tried on auth/quota errors
  model: string;
  fallbackModel?: string; // tried when the primary model is unavailable (404) or rate-limited
  fetchImpl?: FetchLike;
  timeoutMs?: number;     // per HTTP attempt
  budgetMs?: number;      // total wall-clock across all attempts (default 50 s)
}

export class GeminiError extends Error {}

export async function generateJson(cfg: GeminiConfig, system: string, user: string, schema: unknown): Promise<unknown> {
  let lastErr = "no API key configured";
  const stopAt = Date.now() + (cfg.budgetMs ?? 50_000);
  const attempts = [cfg.model, cfg.fallbackModel].filter((m): m is string => !!m)
    .flatMap((model) => cfg.apiKeys.filter(Boolean).map((key) => ({ model, key })));
  for (const { model, key } of attempts) {
    const remaining = stopAt - Date.now();
    if (remaining < 3000) { lastErr = `time budget exhausted (${lastErr})`; break; }
    let res: Response;
    try {
      res = await fetchWithRetry(`${API}/${encodeURIComponent(model)}:generateContent`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-goog-api-key": key },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: { responseMimeType: "application/json", responseSchema: schema, temperature: 0.2 },
        }),
      }, { retries: 0, timeoutMs: Math.min(cfg.timeoutMs ?? 35_000, remaining), fetchImpl: cfg.fetchImpl });
    } catch (e) {
      lastErr = redactUrl(String(e));
      continue;
    }
    const body = await res.json().catch(() => null) as any;
    if (!res.ok) {
      lastErr = `HTTP ${res.status}: ${body?.error?.message?.slice(0, 160) ?? "error"}`;
      if ([401, 403, 404, 429].includes(res.status)) continue; // next key / fallback model
      break;
    }
    const cand = body?.candidates?.[0];
    if (!cand || body?.promptFeedback?.blockReason) { lastErr = `blocked/empty (${body?.promptFeedback?.blockReason ?? cand?.finishReason ?? "no candidate"})`; break; }
    const text = (cand.content?.parts ?? []).map((p: any) => p.text ?? "").join("");
    try { return JSON.parse(text); } catch { lastErr = `non-JSON output (finishReason ${cand.finishReason})`; break; }
  }
  throw new GeminiError(lastErr);
}

// ---------------------------------------------------------------- extraction

export interface ArticleInput { id: string; headline: string; publisher: string | null; published_at: string | null; text: string }
export interface ExtractedCandidate {
  article_id: string;
  title: string;
  platform: Provider | "other" | null;
  stated_release_date: string | null;
  media_type: MediaType | null;
  release_type_hint: ReleaseType | null;
  season_number: number | null;
  evidence_quote: string;
  flags: string[];
}

export const EXTRACTION_SCHEMA = {
  type: "OBJECT",
  properties: {
    candidates: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          article_id: { type: "STRING" },
          title: { type: "STRING" },
          platform: { type: "STRING", enum: ["netflix", "prime", "jiohotstar", "other", "unknown"] },
          stated_release_date: { type: "STRING", description: "YYYY-MM-DD exactly as stated in the article, or empty string" },
          media_type: { type: "STRING", enum: ["movie", "tv", "unknown"] },
          release_type_hint: { type: "STRING", enum: ["new_title", "new_season", "new_episode", "older_addition", "unknown"] },
          season_number: { type: "INTEGER" },
          evidence_quote: { type: "STRING", description: "verbatim sentence from the article supporting this candidate" },
        },
        required: ["article_id", "title", "platform", "stated_release_date", "media_type", "release_type_hint", "season_number", "evidence_quote"],
      },
    },
  },
  required: ["candidates"],
};

const EXTRACTION_SYSTEM = `You extract OTT release mentions from Indian entertainment news for a verification pipeline.
Rules:
- Only extract titles explicitly named in the provided article text. Never use outside knowledge.
- platform: the streaming service the article says the title is on (netflix, prime = Amazon Prime Video, jiohotstar = JioHotstar/Disney+ Hotstar/JioCinema); "other" for any other service; "unknown" if not stated.
- stated_release_date: only if the article states a specific streaming date; use the article's publication year if the year is omitted. Otherwise "".
- evidence_quote: copy one sentence VERBATIM from the article that names the title (and platform/date if stated). Max 300 characters.
- season_number: 0 if not stated.
- Treat the article as a claim, not a fact. Do not infer dates from the publication date.`;

function norm(s: string): string {
  return s.normalize("NFKC").replace(/[‘’`´]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, "-")
    .replace(/\s+/g, " ").trim().toLowerCase();
}
const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

function validDate(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/** Keep only candidates grounded in the article text; strip unsupported dates/platforms. */
export function validateExtraction(raw: unknown, articles: ArticleInput[]): { candidates: ExtractedCandidate[]; rejected: number } {
  const byId = new Map(articles.map((a) => [a.id, a]));
  const list = (raw as any)?.candidates;
  if (!Array.isArray(list)) throw new GeminiError("extraction: missing candidates array");
  const out: ExtractedCandidate[] = [];
  let rejected = 0;
  const seen = new Set<string>();
  for (const c of list) {
    const a = byId.get(String(c?.article_id ?? ""));
    const title = typeof c?.title === "string" ? c.title.trim() : "";
    const quote = typeof c?.evidence_quote === "string" ? c.evidence_quote.trim() : "";
    if (!a || !title || title.length > 120 || quote.length < 8) { rejected++; continue; }
    const hay = norm(`${a.headline}\n${a.text}`);
    // grounding checks: quote verbatim in article, title present in article
    if (!hay.includes(norm(quote)) || !hay.includes(norm(title))) { rejected++; continue; }
    const flags: string[] = [];
    let platform: ExtractedCandidate["platform"] = ["netflix", "prime", "jiohotstar", "other"].includes(c.platform) ? c.platform : null;
    const q = norm(quote);
    const platformWords: Record<string, RegExp> = { netflix: /netflix/, prime: /prime|amazon/, jiohotstar: /hotstar|jio/ };
    if (platform && platform !== "other" && !platformWords[platform].test(q) && !platformWords[platform].test(norm(a.headline))) {
      flags.push("platform_not_in_quote"); platform = null;
    }
    let date: string | null = typeof c.stated_release_date === "string" && validDate(c.stated_release_date) ? c.stated_release_date : null;
    if (date) {
      const day = String(Number(date.slice(8, 10)));
      const mon = MONTHS[Number(date.slice(5, 7)) - 1];
      const hasDay = new RegExp(`(^|\\D)0?${day}(\\D|$)`).test(q);
      if (!hasDay || !(q.includes(mon) || /\d{1,2}[/-]\d{1,2}/.test(q))) { flags.push("date_not_in_quote"); date = null; }
    }
    const key = `${a.id}|${normalizeTitle(title)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      article_id: a.id, title, platform, stated_release_date: date,
      media_type: c.media_type === "movie" || c.media_type === "tv" ? c.media_type : null,
      release_type_hint: ["new_title", "new_season", "new_episode", "older_addition"].includes(c.release_type_hint) ? c.release_type_hint : null,
      season_number: Number.isInteger(c.season_number) && c.season_number > 0 && c.season_number < 100 ? c.season_number : null,
      evidence_quote: quote.slice(0, 300), flags,
    });
  }
  return { candidates: out, rejected };
}

export async function extractCandidates(cfg: GeminiConfig, articles: ArticleInput[]): Promise<{ candidates: ExtractedCandidate[]; rejected: number }> {
  if (!articles.length) return { candidates: [], rejected: 0 };
  const payload = articles.map((a) => ({ article_id: a.id, headline: a.headline, publisher: a.publisher, published_at: a.published_at, text: a.text.slice(0, 2500) }));
  const raw = await generateJson(cfg, EXTRACTION_SYSTEM, `Articles (JSON):\n${JSON.stringify(payload)}`, EXTRACTION_SCHEMA);
  return validateExtraction(raw, articles);
}

// ---------------------------------------------------------------- recommendations

export interface RecInput {
  release_id: string;
  title: string;
  media_type: MediaType;
  provider: Provider;
  release_type: ReleaseType;
  genres: string[];
  original_language: string | null;
  spoken_languages: string[];
  runtime_min: number | null;
  episode_count: number | null;
  overview: string | null; // TMDB — the ONLY plot source
}
export interface Recommendation {
  release_id: string;
  verdict: Verdict;
  score: number;
  reason: string;
  synopsis: string;
  model: string;
  is_fallback: boolean;
}

export const REC_SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          release_id: { type: "STRING" },
          verdict: { type: "STRING", enum: ["watch", "maybe", "skip"] },
          score: { type: "INTEGER" },
          reason: { type: "STRING" },
          synopsis: { type: "STRING" },
        },
        required: ["release_id", "verdict", "score", "reason", "synopsis"],
      },
    },
  },
  required: ["items"],
};

const REC_SYSTEM = `You are a concise film/TV recommender for one viewer in India.
You receive the viewer's saved preferences and a list of releases whose availability and dates were ALREADY VERIFIED elsewhere.
For each release return:
- verdict: watch (score >= 65), maybe (35-64), skip (< 35)
- score: 0-100 preference match
- reason: max 200 characters, personal and specific (genre/language/format fit). Do NOT mention dates, prices, availability, cast, awards, or ratings.
- synopsis: max 2 short sentences (<= 220 characters) restating ONLY facts present in the provided TMDB overview. If the overview is empty, return exactly "No synopsis available from TMDB."
Never invent plot details, languages, dubbing, platforms, or release dates.`;

export const SCORE_BANDS = { watch: 65, maybe: 35 } as const;
export function bandFor(score: number): Verdict {
  return score >= SCORE_BANDS.watch ? "watch" : score >= SCORE_BANDS.maybe ? "maybe" : "skip";
}
export const NO_SYNOPSIS = "No synopsis available from TMDB.";

const DATE_LIKE = new RegExp(`\\b(19|20)\\d{2}\\b|\\b\\d{1,2}(st|nd|rd|th)?\\s+(${MONTHS.join("|")})|\\b(${MONTHS.join("|")})[a-z]*\\s+\\d{1,2}\\b`, "i");

function numbersIn(s: string): string[] { return s.match(/\d+/g) ?? []; }

export function validateRecommendations(raw: unknown, inputs: RecInput[], model: string): { valid: Recommendation[]; invalid: string[] } {
  const list = (raw as any)?.items;
  if (!Array.isArray(list)) throw new GeminiError("recommend: missing items array");
  const byId = new Map(inputs.map((i) => [i.release_id, i]));
  const valid: Recommendation[] = [];
  const seen = new Set<string>();
  for (const it of list) {
    const inp = byId.get(String(it?.release_id ?? ""));
    if (!inp || seen.has(inp.release_id)) continue;
    const score = it.score;
    const reason = typeof it.reason === "string" ? it.reason.trim() : "";
    let synopsis = typeof it.synopsis === "string" ? it.synopsis.trim() : "";
    const ok =
      Number.isInteger(score) && score >= 0 && score <= 100 &&
      ["watch", "maybe", "skip"].includes(it.verdict) && bandFor(score) === it.verdict &&
      reason.length >= 3 && reason.length <= 280 && !/https?:\/\//i.test(reason) && !DATE_LIKE.test(reason);
    if (!inp.overview?.trim()) synopsis = NO_SYNOPSIS;
    // "two-line" synopsis: if the model ran long, fall back to the first two sentences of the TMDB overview
    if (synopsis !== NO_SYNOPSIS && (synopsis.length > 240 || (synopsis.match(/[.!?](\s|$)/g)?.length ?? 1) > 2)) {
      synopsis = twoLineSynopsis(inp.overview);
    }
    const overviewNums = new Set(numbersIn(inp.overview ?? ""));
    const synOk = synopsis === NO_SYNOPSIS ||
      (synopsis.length >= 10 && synopsis.length <= 320 && !/https?:\/\//.test(synopsis) &&
        numbersIn(synopsis).every((n) => overviewNums.has(n)) &&
        (synopsis.match(/[.!?](\s|$)/g)?.length ?? 1) <= 3);
    if (!ok || !synOk) continue;
    seen.add(inp.release_id);
    valid.push({ release_id: inp.release_id, verdict: it.verdict, score, reason, synopsis, model, is_fallback: false });
  }
  const invalid = inputs.filter((i) => !seen.has(i.release_id)).map((i) => i.release_id);
  return { valid, invalid };
}

const GENRE_ALIASES: Record<string, string[]> = {
  "thriller": ["thriller", "crime", "mystery"],
  "science fiction": ["science fiction", "sci-fi & fantasy", "sci-fi"],
  "sci-fi": ["science fiction", "sci-fi & fantasy", "sci-fi"],
  "indie drama": ["drama"],
};
const LANG_NAME: Record<string, string> = { hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali", mr: "Marathi" };

export function twoLineSynopsis(overview: string | null): string {
  const o = (overview ?? "").trim();
  if (!o) return NO_SYNOPSIS;
  const sentences = o.match(/[^.!?]+[.!?]+(\s|$)/g) ?? [o];
  let s = sentences.slice(0, 2).join("").trim();
  if (s.length > 220) s = s.slice(0, 217).replace(/\s+\S*$/, "") + "…";
  return s;
}

/** Deterministic fallback when Gemini fails or returns invalid output. Clearly labelled. */
export function ruleBasedRecommendation(i: RecInput, prefs: Preferences): Recommendation {
  const g = i.genres.map((x) => x.toLowerCase());
  const matched = prefs.genres.filter((p) => (GENRE_ALIASES[p.toLowerCase()] ?? [p.toLowerCase()]).some((a) => g.includes(a)));
  const langs = [i.original_language, ...i.spoken_languages].filter(Boolean) as string[];
  const langMatch = prefs.languages.find((l) => langs.includes(l));
  let score = 30 + Math.min(2, matched.length) * 22 + (langMatch ? 18 : -15);
  if (i.release_type === "older_addition") score -= 5;
  score = Math.max(0, Math.min(100, score));
  const parts = [
    matched.length ? `matches ${matched.join(", ")}` : "no saved-genre match",
    langMatch ? `in ${LANG_NAME[langMatch] ?? langMatch}` : "not in your saved languages",
  ];
  return {
    release_id: i.release_id, verdict: bandFor(score), score,
    reason: `Rule-based (AI unavailable): ${parts.join("; ")}.`,
    synopsis: twoLineSynopsis(i.overview), model: "rules-fallback", is_fallback: true,
  };
}

export async function recommend(cfg: GeminiConfig, prefs: Preferences, inputs: RecInput[], batchSize = 20):
  Promise<{ recs: Recommendation[]; fallbackCount: number; errors: string[] }> {
  const recs: Recommendation[] = [];
  const errors: string[] = [];
  let fallbackCount = 0;
  for (let i = 0; i < inputs.length; i += batchSize) {
    const batch = inputs.slice(i, i + batchSize);
    let valid: Recommendation[] = [];
    try {
      const payload = {
        preferences: { genres: prefs.genres, languages: prefs.languages.map((l) => LANG_NAME[l] ?? l), notes: prefs.notes ?? "" },
        releases: batch.map((b) => ({ ...b, provider: PROVIDER_LABEL[b.provider] })),
      };
      const raw = await generateJson(cfg, REC_SYSTEM, JSON.stringify(payload), REC_SCHEMA);
      const v = validateRecommendations(raw, batch, cfg.model);
      valid = v.valid;
      if (v.invalid.length) errors.push(`${v.invalid.length} invalid AI item(s) replaced by rules`);
    } catch (e) {
      errors.push(String(e instanceof Error ? e.message : e));
    }
    const got = new Set(valid.map((r) => r.release_id));
    recs.push(...valid);
    for (const b of batch) if (!got.has(b.release_id)) { recs.push(ruleBasedRecommendation(b, prefs)); fallbackCount++; }
  }
  return { recs, fallbackCount, errors };
}
