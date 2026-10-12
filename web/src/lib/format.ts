import type { DateBasis, Provider, Recommendation, Release, ReleaseType } from "./types";

const IST = 330 * 60 * 1000;
const DAY = 86_400_000;

export const PROVIDER_LABEL: Record<Provider, string> = { netflix: "Netflix", prime: "Prime Video", jiohotstar: "JioHotstar" };
export const RELEASE_LABEL: Record<ReleaseType, string> = {
  new_title: "New", new_season: "New season", new_episode: "New episodes", older_addition: "Older title, newly added",
};
export const BASIS_LABEL: Record<DateBasis, string> = {
  sa_change: "Added — Streaming Availability",
  snapshot_first_seen: "First observed — JustWatch India snapshot",
  tmdb_episode_air_date: "Episode date — TMDB (platform original)",
  human_review: "Confirmed by manual review",
};
export const LANG: Record<string, string> = {
  hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali", mr: "Marathi",
  ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", de: "German", pa: "Punjabi", gu: "Gujarati", zh: "Chinese", it: "Italian", pt: "Portuguese", tr: "Turkish",
};
export const langName = (c: string | null) => (c ? LANG[c] ?? c.toUpperCase() : "—");

export function istDate(d: Date): string { return new Date(d.getTime() + IST).toISOString().slice(0, 10); }
export function istMidnight(ymd: string): Date { return new Date(Date.parse(`${ymd}T00:00:00Z`) - IST); }

/** Owner-requested one-off extra digests (18:30 IST), in addition to the weekly Friday send. */
const EXTRA_DIGEST_DATES = ["2026-10-12", "2026-10-13"];

/** Next digest (one-off extra or Friday 18:30 IST) strictly after now. */
export function nextDigest(now = new Date()): Date {
  const extra = EXTRA_DIGEST_DATES.map((d) => new Date(Date.parse(`${d}T13:00:00Z`))).filter((d) => d > now);
  const weekly = nextFriday(now);
  return extra.length && extra[0] < weekly ? extra[0] : weekly;
}

function nextFriday(now: Date): Date {
  const s = new Date(now.getTime() + IST);
  const back = (s.getUTCDay() - 5 + 7) % 7;
  let b = Date.UTC(s.getUTCFullYear(), s.getUTCMonth(), s.getUTCDate() - back, 18, 30) - IST;
  if (b > now.getTime()) b -= 7 * DAY;
  return new Date(b + 7 * DAY);
}

export function fmtIst(d: Date | string, opts: Intl.DateTimeFormatOptions = { weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", ...opts }).format(new Date(d));
}
export function fmtDay(ymd: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", weekday: "short", day: "numeric", month: "short" }).format(istMidnight(ymd));
}
export function countdown(to: Date, now = new Date()): string {
  const ms = Math.max(0, to.getTime() - now.getTime());
  const d = Math.floor(ms / DAY), h = Math.floor((ms % DAY) / 3.6e6), m = Math.floor((ms % 3.6e6) / 6e4);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}
export function ago(iso: string, now = new Date()): string {
  const s = Math.round((now.getTime() - Date.parse(iso)) / 1000);
  if (s < 90) return "just now";
  if (s < 5400) return `${Math.round(s / 60)} min ago`;
  if (s < 129600) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
export function runtime(min: number | null): string | null {
  if (!min) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
export function episodes(r: Pick<Release, "media_type" | "season_number" | "episode_number" | "episode_count">): string | null {
  if (r.media_type !== "tv") return null;
  const s = r.season_number != null ? `S${r.season_number}` : "";
  if (r.episode_number != null) {
    const n = r.episode_count ?? 1;
    return n > 1 ? `${s} · E${r.episode_number}–${r.episode_number + n - 1}` : `${s} · E${r.episode_number}`;
  }
  return r.episode_count ? `${s} · ${r.episode_count} episode${r.episode_count === 1 ? "" : "s"}` : s || null;
}

export function availableAt(r: Pick<Release, "available_at" | "available_date">): number | null {
  if (r.available_at) return Date.parse(r.available_at);
  return r.available_date ? istMidnight(r.available_date).getTime() : null;
}
export function inRolling7(r: Pick<Release, "available_at" | "available_date">, now = new Date()): boolean {
  const t = availableAt(r);
  return t != null && t >= now.getTime() - 7 * DAY && t <= now.getTime();
}

export function latestRec(r: Release): Recommendation | null {
  return [...(r.recommendations ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0] ?? null;
}

export const posterUrl = (p: string | null, size = "w342") => (p ? `https://image.tmdb.org/t/p/${size}${p}` : null);
export const tmdbUrl = (r: Pick<Release, "media_type" | "tmdb_id">) => `https://www.themoviedb.org/${r.media_type}/${r.tmdb_id}`;

/** Render Telegram-HTML (b, i, a[href]) safely: escape everything else. */
export function safeTelegramHtml(s: string): string {
  const tokens = s.split(/(<\/?b>|<\/?i>|<a href="https?:\/\/[^"<>]+">|<\/a>)/g);
  return tokens.map((t, i) => (i % 2 === 1 ? t : t.replace(/</g, "&lt;").replace(/>/g, "&gt;"))).join("").replace(/\n/g, "<br/>");
}
