import type { DateBasis, EvidenceOut, VerifiedRelease } from "./types.ts";
import { daysBetween } from "./time.ts";

/** Identity without date: same title, provider, release type, season, episode. */
export function identityKey(r: Pick<VerifiedRelease, "media_type" | "tmdb_id" | "provider" | "release_type" | "season_number" | "episode_number">): string {
  return [r.media_type, r.tmdb_id, r.provider, r.release_type, r.season_number ?? "", r.episode_number ?? ""].join(":");
}

/** Mirrors the DB unique index releases_dedupe_uidx. */
export function dedupeKey(r: VerifiedRelease): string {
  return `${identityKey(r)}:${r.available_date ?? ""}`;
}

const BASIS_RANK: Record<DateBasis, number> = {
  human_review: 4, sa_change: 3, tmdb_episode_air_date: 2, snapshot_first_seen: 1,
};
const STATUS_RANK = { confirmed: 3, needs_review: 2, excluded: 1 } as const;
/** Two reports of the same release whose dates are this close are the same event (sources lag each other). */
export const SAME_EVENT_DAYS = 3;

function rank(r: VerifiedRelease): number[] {
  return [STATUS_RANK[r.verification_status], r.date_basis ? BASIS_RANK[r.date_basis] : 0, r.confidence];
}
function better(a: VerifiedRelease, b: VerifiedRelease): boolean {
  const ra = rank(a), rb = rank(b);
  for (let i = 0; i < ra.length; i++) if (ra[i] !== rb[i]) return ra[i] > rb[i];
  return false;
}

export function evidenceKey(e: EvidenceOut): string {
  return [e.evidence_type, e.source_id ?? "", e.url ?? "", e.stated_date ?? ""].join("|");
}

function close(a: string | null, b: string | null): boolean {
  if (!a || !b) return true;
  return Math.abs(daysBetween(a, b)) <= SAME_EVENT_DAYS;
}

/**
 * Merge duplicate reports of the same release (e.g. Streaming Availability + snapshot diff + article),
 * keeping the strongest status/date basis and the union of evidence and notes.
 */
export function mergeReleases(list: VerifiedRelease[]): VerifiedRelease[] {
  const groups = new Map<string, VerifiedRelease[]>();
  for (const r of list) {
    const k = identityKey(r);
    const clusters = groups.get(k) ?? [];
    const hit = clusters.find((c) => close(c.available_date, r.available_date));
    if (!hit) { clusters.push(structuredClone(r)); groups.set(k, clusters); continue; }
    const primary = better(r, hit) ? structuredClone(r) : hit;
    const other = primary === hit ? r : hit;
    const ev = new Map(primary.evidence.map((e) => [evidenceKey(e), e]));
    for (const e of other.evidence) if (!ev.has(evidenceKey(e))) ev.set(evidenceKey(e), e);
    primary.evidence = [...ev.values()];
    primary.notes = [...new Set([...primary.notes, ...other.notes])];
    primary.confidence = Math.max(primary.confidence, other.confidence);
    primary.watch_link = primary.watch_link ?? other.watch_link;
    primary.episode_count = primary.episode_count ?? other.episode_count;
    if (primary !== hit) clusters[clusters.indexOf(hit)] = primary;
  }
  return [...groups.values()].flat();
}

export function normalizeTitle(s: string): string {
  return s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase()
    .replace(/&/g, " and ").replace(/['’`"]/g, "").replace(/[^a-z0-9ऀ-෿]+/g, " ")
    .replace(/\b(season|s)\s*\d+\b/g, " ").replace(/\s+/g, " ").trim();
}

/** Strip tracking params / fragments so the same article from two feeds dedupes. */
export function canonicalUrl(u: string): string {
  try {
    const url = new URL(u);
    url.hash = "";
    for (const k of [...url.searchParams.keys()]) {
      if (/^(utm_|fbclid|gclid|ref$|ref_|amp$|oc$)/i.test(k)) url.searchParams.delete(k);
    }
    url.hostname = url.hostname.toLowerCase();
    return url.toString().replace(/\/$/, "");
  } catch {
    return u.trim();
  }
}
