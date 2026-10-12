// Verification rules — the heart of "never present unverified releases as confirmed".
//
// Evidence that CAN confirm India OTT availability within the window:
//   A. Streaming Availability /changes (country=in, change_type=new) with a timestamp in the window,
//      AND the title is listed on that provider in India by TMDB/JustWatch.               → confidence 0.95
//   B. TMDB episode air date in the window for a platform ORIGINAL (TMDB network = provider)
//      that TMDB/JustWatch lists on that provider in India.                                → confidence 0.85
//   C. Our own snapshot diff: absent in a previous complete India snapshot, present now,
//      first observed inside the window.                                                    → confidence 0.75
// Evidence that can NEVER confirm on its own (→ needs_review or excluded):
//   - News articles (publication date ≠ release date; may be forecasts, stale, wrong)
//   - TMDB release_dates "Digital" notes (community free text)
//   - TMDB air dates of non-original series (original network's date, not India OTT)
import {
  type ArticleClaim, type EpisodeAir, type EvidenceOut, type Provider, PROVIDER_LABEL, type ReleaseType,
  type SaChange, type SnapshotObservation, type TitleFacts, TMDB_NETWORK_MAP, type VerifiedRelease,
  providerFromName,
} from "./types.ts";
import { dateInWindow, daysBetween, formatIst, inWindow, istDate, type TimeWindow } from "./time.ts";
import { mergeReleases } from "./dedupe.ts";

export const CONFIRM_THRESHOLD = 0.7;
/** A title first available on OTT more than this many days after its original release is an "older addition". */
export const OLDER_ADDITION_DAYS = 120;
/** Articles that disagree on a date by more than this are "conflicting". */
export const CONFLICT_DAYS = 2;

export interface VerifyInput {
  facts: TitleFacts;
  provider: Provider;
  saChanges: SaChange[];
  snapshot?: SnapshotObservation | null;
  episodes: EpisodeAir[];
  claims: ArticleClaim[];
}

export function classifyTitle(facts: TitleFacts, availableDate: string): ReleaseType {
  if (!facts.release_date) return "new_title";
  return daysBetween(facts.release_date, availableDate) > OLDER_ADDITION_DAYS ? "older_addition" : "new_title";
}

function base(facts: TitleFacts, provider: Provider): Pick<VerifiedRelease, "media_type" | "tmdb_id" | "provider" | "watch_link"> {
  return { media_type: facts.media_type, tmdb_id: facts.tmdb_id, provider, watch_link: facts.watch_link ?? null };
}

function currentAvailabilityEvidence(facts: TitleFacts, provider: Provider): EvidenceOut {
  const on = facts.available_in.includes(provider);
  return {
    evidence_type: "availability_current",
    stance: on ? "supports" : "conflicts",
    url: facts.watch_link ?? null,
    detail: { source: "TMDB watch providers (data by JustWatch)", region: "IN", providers: facts.available_in },
  };
}

function digitalNoteEvidence(facts: TitleFacts, provider: Provider): EvidenceOut[] {
  return (facts.in_digital_notes ?? [])
    .filter((n) => providerFromName(n.note) === provider)
    .map((n) => ({
      evidence_type: "tmdb_digital_note" as const, stance: "context" as const, stated_date: n.date,
      stated_platform: n.note, detail: { source: "TMDB release_dates (IN, type 4 Digital) — community-entered, context only" },
    }));
}

/** Group TV episode rows released together (same season + same date): a premiere drop becomes one row. */
function collapseEpisodes(rows: VerifiedRelease[]): VerifiedRelease[] {
  const out: VerifiedRelease[] = [];
  const groups = new Map<string, VerifiedRelease[]>();
  for (const r of rows) {
    if (r.media_type !== "tv" || r.season_number == null || r.episode_number == null) { out.push(r); continue; }
    const k = [r.provider, r.season_number, r.available_date, r.verification_status, r.date_basis].join("|");
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  for (const g of groups.values()) {
    g.sort((a, b) => a.episode_number! - b.episode_number!);
    const first = structuredClone(g[0]);
    const eps = g.map((x) => x.episode_number!);
    first.episode_count = eps.length;
    first.evidence = g.flatMap((x) => x.evidence);
    first.notes = [...new Set(g.flatMap((x) => x.notes))];
    if (eps.includes(1)) {
      // Season premiere (possibly a full-season drop) → new season / new title row, no single episode number.
      first.release_type = first.season_number === 1 ? first.release_type === "older_addition" ? "older_addition" : "new_title" : "new_season";
      first.episode_number = null;
    } else {
      first.release_type = "new_episode";
      first.episode_number = eps[0];
      if (eps.length > 1) first.notes.push(`Episodes ${eps[0]}–${eps[eps.length - 1]} released together.`);
    }
    out.push(first);
  }
  return out;
}

export function verifyTitle(input: VerifyInput, window: TimeWindow, now: Date): VerifiedRelease[] {
  const { facts, provider } = input;
  // Nothing can be "available" in the future: cap the window at now (scheduled air dates are not availability).
  const w: TimeWindow = { ...window, end: new Date(Math.min(window.end.getTime(), now.getTime() + 1)) };
  const label = PROVIDER_LABEL[provider];
  const onPlatformNow = facts.available_in.includes(provider);
  const isOriginal = facts.networks.some((n) => TMDB_NETWORK_MAP[n] === provider);
  const current = currentAvailabilityEvidence(facts, provider);
  const notesCtx = digitalNoteEvidence(facts, provider);
  const rows: VerifiedRelease[] = [];

  // A. Streaming Availability changes
  for (const c of input.saChanges) {
    if (c.provider !== provider) continue;
    const at = new Date(c.timestamp * 1000);
    if (!inWindow(at, w)) continue;
    const date = istDate(at);
    let release_type: ReleaseType;
    let season: number | null = null, episode: number | null = null;
    if (c.item_type === "episode") { release_type = "new_episode"; season = c.season ?? null; episode = c.episode ?? null; }
    else if (c.item_type === "season") {
      season = c.season ?? null;
      release_type = season === 1 ? classifyTitle(facts, date) : "new_season";
    } else release_type = classifyTitle(facts, date);
    const ev: EvidenceOut = {
      evidence_type: "availability_change", stance: "supports", url: c.link ?? null,
      detail: { source: "Streaming Availability API /changes", country: "in", item_type: c.item_type, timestamp: c.timestamp },
    };
    rows.push({
      ...base(facts, provider), release_type, season_number: season, episode_number: episode,
      available_date: date, available_at: at.toISOString(), date_basis: "sa_change",
      verification_status: onPlatformNow ? "confirmed" : "needs_review",
      confidence: onPlatformNow ? 0.95 : 0.6,
      notes: onPlatformNow ? [] : [`Provider mismatch: Streaming Availability reports a new ${label} India addition, but TMDB/JustWatch India does not list it on ${label} yet.`],
      evidence: [ev, current, ...notesCtx],
      watch_link: c.link ?? facts.watch_link ?? null,
    });
  }

  // C. Snapshot first-seen (fallback / corroboration)
  const s = input.snapshot;
  if (s && s.provider === provider && s.added_after && inWindow(new Date(s.first_seen_at), w)) {
    const seen = new Date(s.first_seen_at);
    const date = istDate(seen);
    const ev: EvidenceOut = {
      evidence_type: "availability_snapshot", stance: "supports",
      detail: { source: "Daily India snapshot of TMDB/JustWatch availability", added_after: s.added_after, first_seen_at: s.first_seen_at },
    };
    const titleLevel = rows.find((r) => r.season_number == null && r.episode_number == null && r.date_basis === "sa_change");
    if (titleLevel) {
      titleLevel.evidence.push(ev);
      titleLevel.confidence = Math.min(0.99, titleLevel.confidence + 0.03);
    } else {
      const window = `between ${formatIst(new Date(s.added_after))} and ${formatIst(seen)}`;
      rows.push({
        ...base(facts, provider), release_type: classifyTitle(facts, date), season_number: null, episode_number: null,
        available_date: date, available_at: null, date_basis: "snapshot_first_seen",
        verification_status: onPlatformNow ? "confirmed" : "needs_review",
        confidence: onPlatformNow ? 0.75 : 0.45,
        notes: [onPlatformNow
          ? `First observed on ${label} India ${window} (our snapshot of TMDB/JustWatch data — not an official launch time).`
          : `Seen on ${label} India ${window}, but no longer listed — possibly removed or a data glitch.`],
        evidence: [ev, current, ...notesCtx],
      });
    }
  }

  // B. TMDB episode air dates — only originals of this provider count as India OTT evidence
  if (facts.media_type === "tv") {
    for (const e of input.episodes) {
      if (!dateInWindow(e.air_date, w)) continue;
      const already = rows.some((r) => r.season_number === e.season && (r.episode_number === e.episode || r.release_type === "new_season"));
      if (already) continue;
      const ev: EvidenceOut = {
        evidence_type: "episode_air_date", stance: isOriginal ? "supports" : "context", stated_date: e.air_date,
        detail: { source: "TMDB season details", season: e.season, episode: e.episode, original: isOriginal },
      };
      if (isOriginal && onPlatformNow) {
        rows.push({
          ...base(facts, provider), release_type: e.episode === 1 && e.season === 1 ? classifyTitle(facts, e.air_date) : "new_episode",
          season_number: e.season, episode_number: e.episode, available_date: e.air_date, available_at: null,
          date_basis: "tmdb_episode_air_date", verification_status: "confirmed", confidence: 0.85,
          notes: [`${label} original: TMDB episode air date; listed on ${label} India by TMDB/JustWatch.`],
          evidence: [ev, current], episode_count: e.season_episode_count ?? null,
        });
      } else if (input.claims.length) {
        rows.push({
          ...base(facts, provider), release_type: "new_episode", season_number: e.season, episode_number: e.episode,
          available_date: e.air_date, available_at: null, date_basis: null, verification_status: "needs_review", confidence: 0.4,
          notes: [isOriginal
            ? `${label} original airing, but TMDB/JustWatch does not list it on ${label} India.`
            : `Air date comes from the original network — not proof of ${label} India availability.`],
          evidence: [ev, current],
        });
      }
    }
  }

  let out = collapseEpisodes(rows);

  // D. Articles — discovery/corroboration only
  const forProvider = input.claims.filter((c) => c.stated_platform === provider || c.stated_platform == null);
  const otherPlatforms = [...new Set(input.claims.map((c) => c.stated_platform).filter((p): p is Provider | "other" => !!p && p !== provider))];
  const toEvidence = (c: ArticleClaim, stance: EvidenceOut["stance"]): EvidenceOut => ({
    evidence_type: "news_article", stance, source_id: c.source_id, url: c.url, stated_date: c.stated_date,
    stated_platform: c.stated_platform, quote: c.quote.slice(0, 600),
    detail: { publisher: c.publisher, published_at: c.published_at },
  });

  const confirmed = out.filter((r) => r.verification_status === "confirmed");
  if (confirmed.length) {
    for (const c of forProvider) {
      const target = confirmed.reduce((best, r) =>
        c.stated_date && r.available_date && best.available_date &&
          Math.abs(daysBetween(c.stated_date, r.available_date)) < Math.abs(daysBetween(c.stated_date, best.available_date)) ? r : best);
      const agrees = !c.stated_date || !target.available_date || Math.abs(daysBetween(c.stated_date, target.available_date)) <= CONFLICT_DAYS;
      target.evidence.push(toEvidence(c, agrees ? "supports" : "conflicts"));
      if (!agrees) target.notes.push(`${c.publisher ?? "An article"} states ${c.stated_date}; structured source says ${target.available_date}. Structured source kept.`);
    }
    if (otherPlatforms.length) for (const r of confirmed) r.notes.push(`Some articles name a different platform (${otherPlatforms.join(", ")}).`);
  } else if (forProvider.length) {
    const today = istDate(now);
    const dates = [...new Set(forProvider.map((c) => c.stated_date).filter((d): d is string => !!d))].sort();
    const notes: string[] = ["Article-only evidence: no structured source confirms India availability yet."];
    if (otherPlatforms.length) notes.push(`Provider mismatch: articles also name ${otherPlatforms.join(", ")}.`);
    if (!onPlatformNow) notes.push(`TMDB/JustWatch India does not list it on ${label}.`);
    const spread = dates.length > 1 ? daysBetween(dates[0], dates[dates.length - 1]) : 0;
    if (spread > CONFLICT_DAYS) notes.push(`Conflicting articles: stated dates ${dates.join(", ")}.`);
    const evidence = [...forProvider.map((c) => toEvidence(c, "context")), current, ...notesCtx];
    const common = { ...base(facts, provider), season_number: null, episode_number: null, available_at: null, date_basis: null, evidence };

    if (!dates.length) {
      out.push({ ...common, release_type: classifyTitle(facts, today), available_date: null,
        verification_status: "needs_review", confidence: 0.2, notes: [...notes, "Missing launch date: no article states a date."] });
    } else if (dates.every((d) => d > today)) {
      out.push({ ...common, release_type: classifyTitle(facts, dates[0]), available_date: dates[0],
        verification_status: "excluded", confidence: 0.1, notes: [...notes, `Announced for ${dates[0]} (future) — forecast, not yet available.`] });
    } else {
      const inW = dates.filter((d) => dateInWindow(d, w));
      if (inW.length) {
        const d = inW[inW.length - 1];
        const boost = notesCtx.some((n) => n.stated_date === d) ? 0.1 : 0;
        out.push({ ...common, release_type: classifyTitle(facts, d), available_date: d,
          verification_status: "needs_review", confidence: Math.min(0.5, (onPlatformNow ? 0.4 : 0.25) + boost), notes });
      } else {
        out.push({ ...common, release_type: classifyTitle(facts, dates[dates.length - 1]), available_date: dates[dates.length - 1],
          verification_status: "excluded", confidence: 0.1, notes: [...notes, "Stated date is outside this window (stale or future)."] });
      }
    }
  }

  // Final guard: nothing below threshold or without a date/basis may be "confirmed".
  for (const r of out) {
    if (r.verification_status === "confirmed" && (r.confidence < CONFIRM_THRESHOLD || !r.available_date || !r.date_basis)) {
      r.verification_status = "needs_review";
      r.notes.push("Downgraded: insufficient confidence for confirmation.");
    }
    r.confidence = Math.round(r.confidence * 100) / 100;
  }
  out = mergeReleases(out);
  return out;
}
