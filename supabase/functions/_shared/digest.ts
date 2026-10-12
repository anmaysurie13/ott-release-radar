import { escapeHtml } from "./telegram.ts";
import { formatIst, istMidnight, type TimeWindow } from "./time.ts";
import { type DateBasis, type MediaType, type Provider, PROVIDER_LABEL, type ReleaseType, type Verdict } from "./types.ts";

export interface DigestRelease {
  id: string;
  title: string;
  year: number | null;
  media_type: MediaType;
  provider: Provider;
  release_type: ReleaseType;
  season_number: number | null;
  episode_number: number | null;
  episode_count: number | null;
  available_date: string;
  available_at: string | null;
  date_basis: DateBasis;
  genres: string[];
  original_language: string | null;
  runtime_min: number | null;
  watch_link: string | null;
  evidence_url: string | null;
  /** true = not in an earlier sent digest (only set when an earlier digest overlaps this window) */
  is_new?: boolean;
  rec: { verdict: Verdict; score: number; reason: string; synopsis: string; is_fallback: boolean } | null;
}

export const LANG: Record<string, string> = {
  hi: "Hindi", en: "English", ta: "Tamil", te: "Telugu", ml: "Malayalam", kn: "Kannada", bn: "Bengali", mr: "Marathi",
  ko: "Korean", ja: "Japanese", es: "Spanish", fr: "French", de: "German", pa: "Punjabi", gu: "Gujarati",
};
export const RELEASE_LABEL: Record<ReleaseType, string> = {
  new_title: "New", new_season: "New season", new_episode: "New episode(s)", older_addition: "Newly added (older title)",
};
export const BASIS_LABEL: Record<DateBasis, string> = {
  sa_change: "added (Streaming Availability)",
  snapshot_first_seen: "first observed (TMDB/JustWatch snapshot)",
  tmdb_episode_air_date: "episode date (TMDB, platform original)",
  human_review: "confirmed by review",
};

export function shortDate(ymd: string): string {
  return new Date(istMidnight(ymd).getTime() + 330 * 60000).toUTCString().slice(0, 11).replace(",", ""); // "Fri 16 Oct"
}
export function formatRuntime(min: number | null): string | null {
  if (!min) return null;
  const h = Math.floor(min / 60), m = min % 60;
  return h ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}
export function formatEpisodes(r: Pick<DigestRelease, "media_type" | "season_number" | "episode_number" | "episode_count">): string | null {
  if (r.media_type !== "tv") return null;
  const s = r.season_number != null ? `S${r.season_number}` : "";
  if (r.episode_number != null) {
    const n = r.episode_count ?? 1;
    return n > 1 ? `${s} E${r.episode_number}–E${r.episode_number + n - 1}` : `${s} E${r.episode_number}`;
  }
  return r.episode_count ? `${s} · ${r.episode_count} episode${r.episode_count === 1 ? "" : "s"}`.replace(/^ · /, "") : s || null;
}

function itemBlock(r: DigestRelease, n: number): string {
  const e = escapeHtml;
  const head = `${r.is_new ? "🆕 " : ""}<b>${n}. ${e(r.title)}</b>${r.year ? ` (${r.year})` : ""} · ${PROVIDER_LABEL[r.provider]}`;
  const when = `📅 ${shortDate(r.available_date)} — ${BASIS_LABEL[r.date_basis]} · ${RELEASE_LABEL[r.release_type]}`;
  const meta = [r.genres.slice(0, 3).join(", "), r.original_language ? (LANG[r.original_language] ?? r.original_language) : null,
    formatEpisodes(r) ?? formatRuntime(r.runtime_min)].filter(Boolean).join(" · ");
  const lines = [head, when, meta ? `🎭 ${e(meta)}` : ""];
  if (r.rec) {
    lines.push(`📝 ${e(r.rec.synopsis)}`);
    lines.push(`🤖 <b>${r.rec.verdict.toUpperCase()} ${r.rec.score}/100</b>${r.rec.is_fallback ? " (rules)" : ""} — ${e(r.rec.reason)}`);
  }
  const links = [r.watch_link ? `<a href="${e(r.watch_link)}">Where to watch</a>` : null,
    r.evidence_url && r.evidence_url !== r.watch_link ? `<a href="${e(r.evidence_url)}">Source</a>` : null].filter(Boolean);
  if (links.length) lines.push(`🔗 ${links.join(" · ")}`);
  return lines.filter(Boolean).join("\n");
}

export interface DigestInput {
  window: TimeWindow;
  items: DigestRelease[];
  includeOlder: boolean;
  reviewCount: number;
  dashboardUrl: string | null;
  isTest: boolean;
  degradedSources: string[];
}

/** Collapse a show's individual new-episode rows (e.g. a daily show) into one item per show/provider/season. */
export function groupEpisodes(items: DigestRelease[]): DigestRelease[] {
  const out: DigestRelease[] = [];
  const groups = new Map<string, DigestRelease[]>();
  for (const it of items) {
    if (it.release_type !== "new_episode") { out.push(it); continue; }
    const k = `${it.media_type}:${it.title}:${it.provider}:${it.season_number ?? ""}`;
    groups.set(k, [...(groups.get(k) ?? []), it]);
  }
  for (const g of groups.values()) {
    if (g.length === 1) { out.push(g[0]); continue; }
    g.sort((a, b) => a.available_date.localeCompare(b.available_date));
    const last = g[g.length - 1];
    out.push({
      ...last,
      episode_number: null,
      episode_count: g.reduce((n, x) => n + (x.episode_count ?? 1), 0),
      rec: g.find((x) => x.rec)?.rec ?? null,
      is_new: g.some((x) => x.is_new) || (g.every((x) => x.is_new === undefined) ? undefined : false),
    });
  }
  return out;
}

export function sortItems(items: DigestRelease[]): DigestRelease[] {
  return [...items].sort((a, b) => (b.rec?.score ?? -1) - (a.rec?.score ?? -1) || a.title.localeCompare(b.title));
}

export function buildDigestBlocks(d: DigestInput): { blocks: string[]; sections: { id: string; section: "top" | "more" | "older" | "skipped" }[] } {
  const e = escapeHtml;
  const blocks: string[] = [];
  const sections: { id: string; section: "top" | "more" | "older" | "skipped" }[] = [];
  const header = [
    d.isTest ? "🧪 <b>TEST MESSAGE</b> — preview of the next digest, not the scheduled send." : null,
    "🎬 <b>Release Radar — New This Week in India</b>",
    `<i>${formatIst(d.window.start)} → ${formatIst(d.window.end)}</i>`,
  ].filter(Boolean).join("\n");
  blocks.push(header);

  const grouped = groupEpisodes(d.items);
  // What's new on each of the three apps (verified, after language/platform preferences).
  const perApp = (Object.keys(PROVIDER_LABEL) as Provider[])
    .map((p) => {
      const n = grouped.filter((i) => i.provider === p && (d.includeOlder || i.release_type !== "older_addition")).length;
      return `${PROVIDER_LABEL[p]} ${n ? `<b>${n}</b>` : "—"}`;
    }).join(" · ");
  blocks.push(`📺 New on your apps: ${perApp}`);
  const fresh = sortItems(grouped.filter((i) => i.release_type !== "older_addition"));
  const older = sortItems(grouped.filter((i) => i.release_type === "older_addition"));
  const top = fresh.filter((i) => i.rec?.verdict === "watch");
  const more = fresh.filter((i) => i.rec?.verdict === "maybe" || !i.rec);
  const skipped = fresh.filter((i) => i.rec?.verdict === "skip");

  let n = 0;
  if (!top.length && !more.length) {
    blocks.push(d.items.length
      ? "No new releases matched your preferences strongly enough this week."
      : "No confirmed new releases on your platforms this week.");
  }
  if (top.length) {
    blocks.push("⭐ <b>Top matches</b>");
    for (const r of top) { blocks.push(itemBlock(r, ++n)); sections.push({ id: r.id, section: "top" }); }
  }
  if (more.length) {
    blocks.push("👀 <b>Maybe</b>");
    for (const r of more) { blocks.push(itemBlock(r, ++n)); sections.push({ id: r.id, section: "more" }); }
  }
  if (skipped.length) {
    const names = skipped.slice(0, 8).map((s) => `${e(s.title)} (${PROVIDER_LABEL[s.provider]})`).join(", ");
    blocks.push(`⏭ Skipped as poor matches: ${names}${skipped.length > 8 ? ` and ${skipped.length - 8} more` : ""}`);
    for (const r of skipped) sections.push({ id: r.id, section: "skipped" });
  }
  if (d.includeOlder && older.length) {
    blocks.push("📼 <b>Older titles newly added</b>");
    for (const r of older) { blocks.push(itemBlock(r, ++n)); sections.push({ id: r.id, section: "older" }); }
  }

  const foot: string[] = [];
  if (d.reviewCount) foot.push(`🔎 ${d.reviewCount} unverified item(s) await review — not included above.`);
  if (d.degradedSources.length) foot.push(`⚠️ Limited sources this week: ${e(d.degradedSources.join("; "))}.`);
  foot.push("ℹ️ Facts: TMDB (availability data by JustWatch), Streaming Availability, news (discovery only). 🤖 = AI opinion (Gemini) — the decision is yours.");
  if (d.dashboardUrl) foot.push(`<a href="${e(d.dashboardUrl)}">Open dashboard</a>`);
  blocks.push(foot.join("\n"));
  return { blocks, sections };
}
