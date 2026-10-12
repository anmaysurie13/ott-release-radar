// News discovery (evidence only — never proof of availability).
//  - Google News RSS search (gl=IN) for weekly OTT roundups: headline, publisher, pubDate, link, snippet.
//  - Publisher RSS (Indian Express entertainment / web-series) whose article pages we fetch for full text.
import { type FetchLike, fetchWithRetry, mapLimit } from "./http.ts";
import { canonicalUrl } from "./dedupe.ts";

export const GOOGLE_NEWS_QUERIES = [
  "OTT releases this week India",
  "new Netflix Prime Video JioHotstar releases this Friday",
  "new Hindi OTT releases this week",
  "new Tamil OTT releases this week",
  "new English web series streaming India this week",
];

// Google News RSS answered 503 to Supabase Edge IPs in live tests (it works from residential IPs), so publisher feeds
// carry discovery when it is blocked. All reachable as of 2026-10-12. Only Indian Express article pages are fetched in full.
export const PUBLISHER_FEEDS = [
  { url: "https://indianexpress.com/section/entertainment/web-series/feed/", publisher: "The Indian Express", fetchArticles: true },
  { url: "https://indianexpress.com/section/entertainment/feed/", publisher: "The Indian Express", fetchArticles: true },
  { url: "https://www.news18.com/commonfeeds/v1/eng/rss/movies.xml", publisher: "News18", fetchArticles: false },
  { url: "https://www.thehindu.com/entertainment/movies/feeder/default.rss", publisher: "The Hindu", fetchArticles: false },
  { url: "https://www.koimoi.com/feed/", publisher: "Koimoi", fetchArticles: false },
  { url: "https://www.pinkvilla.com/rss.xml", publisher: "Pinkvilla", fetchArticles: false },
  { url: "https://feeds.feedburner.com/ndtvmovies-latest", publisher: "NDTV", fetchArticles: false },
];

export const UA = "OTTReleaseRadar/1.0 (personal weekly digest; low volume)";

export interface FeedItem {
  title: string;
  url: string;
  publisher: string | null;
  published_at: string | null;
  snippet: string;
  kind: "news_rss" | "publisher_rss";
  query?: string;
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", ldquo: "“", rdquo: "”", ndash: "–", mdash: "—", hellip: "…" };
export function decodeEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}
function cdata(s: string): string { return s.replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, "$1"); }
export function stripHtml(s: string): string {
  return decodeEntities(s.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, " ").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
}
function tag(block: string, name: string): string | null {
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i"));
  return m ? cdata(m[1].trim()) : null;
}

export function parseRss(xml: string, kind: FeedItem["kind"], defaultPublisher: string | null, query?: string): FeedItem[] {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1]);
  const out: FeedItem[] = [];
  for (const it of items) {
    const rawTitle = decodeEntities(stripHtml(tag(it, "title") ?? ""));
    const link = (tag(it, "link") ?? "").trim();
    if (!rawTitle || !/^https?:\/\//.test(link)) continue;
    const source = tag(it, "source");
    const publisher = source ? stripHtml(source) : defaultPublisher;
    // Google News appends " - Publisher" to titles
    const title = publisher && rawTitle.endsWith(` - ${publisher}`) ? rawTitle.slice(0, -(publisher.length + 3)) : rawTitle;
    const pub = tag(it, "pubDate");
    const ts = pub ? Date.parse(pub) : NaN;
    out.push({
      title, url: canonicalUrl(link), publisher, kind, query,
      published_at: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
      snippet: stripHtml(tag(it, "description") ?? "").slice(0, 1000),
    });
  }
  return out;
}

export function googleNewsUrl(q: string): string {
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=en-IN&gl=IN&ceid=IN:en`;
}

const OTT_RE = /\b(ott|netflix|prime video|amazon prime|jiohotstar|hotstar|streaming|web series|what to watch|releases? this (week|friday|weekend))\b/i;
export function isOttRelated(title: string): boolean { return OTT_RE.test(title); }

/** Paragraph text of an article page (no boilerplate), bounded. */
export function extractArticleText(html: string, max = 8000): string {
  const body = html.match(/<article[\s\S]*?<\/article>/i)?.[0] ?? html;
  const paras = [...body.matchAll(/<(p|h2|h3|li)(?:\s[^>]*)?>([\s\S]*?)<\/\1>/gi)].map((m) => stripHtml(m[2])).filter((t) => t.length > 25);
  return paras.join("\n").slice(0, max);
}

export async function fetchText(url: string, fetchImpl?: FetchLike, timeoutMs = 15000): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetchWithRetry(url, { headers: { "user-agent": UA, accept: "application/rss+xml, text/html;q=0.9, */*;q=0.5" } },
    { retries: 0, timeoutMs, fetchImpl });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

export async function discoverNews(o: { since: Date; fetchImpl?: FetchLike; maxArticleFetches?: number }): Promise<{
  items: (FeedItem & { article_text?: string })[]; health: Record<string, string>;
}> {
  const health: Record<string, string> = {};
  const all = new Map<string, FeedItem & { article_text?: string }>();
  const [gn, feeds] = await Promise.all([
    mapLimit(GOOGLE_NEWS_QUERIES, 3, async (q) => {
      try {
        const r = await fetchText(googleNewsUrl(q), o.fetchImpl, 8000);
        const items = r.ok ? parseRss(r.text, "news_rss", null, q) : [];
        health[`google_news:${q}`] = r.ok ? `ok (${items.length})` : `HTTP ${r.status}`;
        return items;
      } catch (e) { health[`google_news:${q}`] = `error: ${String(e).slice(0, 120)}`; return []; }
    }),
    mapLimit(PUBLISHER_FEEDS, 4, async (f) => {
      try {
        const r = await fetchText(f.url, o.fetchImpl, 10000);
        const items = r.ok ? parseRss(r.text, "publisher_rss", f.publisher).map((i) => ({ ...i, fetchable: f.fetchArticles })) : [];
        health[`feed:${f.publisher}`] = r.ok ? `ok (${items.length})` : `HTTP ${r.status}`;
        return items;
      } catch (e) { health[`feed:${f.publisher}`] = `error: ${String(e).slice(0, 120)}`; return []; }
    }),
  ]);
  for (const it of gn.flat()) if (!all.has(it.url)) all.set(it.url, it);
  const toFetch: (FeedItem & { article_text?: string })[] = [];
  for (const { fetchable, ...it } of feeds.flat()) {
    if (all.has(it.url)) continue;
    all.set(it.url, it);
    if (fetchable && isOttRelated(it.title) && it.published_at && new Date(it.published_at) >= o.since) toFetch.push(all.get(it.url)!);
  }
  const max = o.maxArticleFetches ?? 6;
  let fetched = 0;
  await mapLimit(toFetch.slice(0, max), 4, async (it) => {
    try {
      const r = await fetchText(it.url, o.fetchImpl, 8000);
      if (r.ok) { it.article_text = extractArticleText(r.text); fetched++; }
    } catch { /* tolerate individual article failures */ }
  });
  health["article_pages"] = `fetched ${fetched}/${Math.min(toFetch.length, max)}`;
  const recent = [...all.values()].filter((i) => !i.published_at || new Date(i.published_at) >= o.since);
  return { items: recent, health };
}
