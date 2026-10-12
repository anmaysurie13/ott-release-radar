export type Provider = "netflix" | "prime" | "jiohotstar";
export type MediaType = "movie" | "tv";
export type ReleaseType = "new_title" | "new_season" | "new_episode" | "older_addition";
export type VerificationStatus = "confirmed" | "needs_review" | "excluded";
export type DateBasis = "sa_change" | "snapshot_first_seen" | "tmdb_episode_air_date" | "human_review";
export type Verdict = "watch" | "maybe" | "skip";

export const PROVIDERS: Provider[] = ["netflix", "prime", "jiohotstar"];
export const PROVIDER_LABEL: Record<Provider, string> = {
  netflix: "Netflix",
  prime: "Prime Video",
  jiohotstar: "JioHotstar",
};

/** TMDB watch-provider ids (region IN) → our provider. Verified live 2026-10-12 via /watch/providers. */
export const TMDB_PROVIDER_MAP: Record<number, Provider> = {
  8: "netflix", 175: "netflix",        // Netflix, Netflix Kids
  119: "prime", 2100: "prime",         // Amazon Prime Video, Prime Video with Ads (613 "Free with Ads" is not the subscription → excluded)
  2336: "jiohotstar", 122: "jiohotstar", // JioHotstar (122 = legacy Hotstar id, if it reappears)
};
export const TMDB_PROVIDER_IDS: Record<Provider, number[]> = { netflix: [8, 175], prime: [119, 2100], jiohotstar: [2336] };

/** TMDB TV network ids → provider for platform originals. Verified live 2026-10-12 via /network/{id}. */
export const TMDB_NETWORK_MAP: Record<number, Provider> = {
  213: "netflix", 1024: "prime", 8036: "jiohotstar", 3919: "jiohotstar", // 3919 = Disney+ Hotstar IN (pre-merger originals)
};

/** Map a free-text service/platform name to our provider. */
export function providerFromName(name: string | null | undefined): Provider | "other" | null {
  if (!name) return null;
  const n = name.toLowerCase();
  if (/netflix/.test(n)) return "netflix";
  if (/prime|amazon/.test(n)) return "prime";
  if (/hotstar|jio ?cinema|jiohotstar|disney\+? ?hotstar/.test(n)) return "jiohotstar";
  return "other";
}

export interface TitleFacts {
  media_type: MediaType;
  tmdb_id: number;
  title: string;
  original_title?: string | null;
  original_language?: string | null;
  spoken_languages: string[];
  genres: string[];
  overview?: string | null;
  poster_path?: string | null;
  backdrop_path?: string | null;
  release_date?: string | null;   // movie primary release / tv first_air_date (any region; NOT OTT evidence)
  runtime_min?: number | null;
  networks: number[];
  /** Providers with flatrate/ads/free availability in IN right now (TMDB data by JustWatch). */
  available_in: Provider[];
  watch_link?: string | null;
  /** IN Digital release notes from TMDB release_dates (community-entered; context only). */
  in_digital_notes?: { date: string; note: string }[];
}

export interface SaChange {
  provider: Provider;
  item_type: "show" | "season" | "episode";
  show_type: "movie" | "series";
  tmdb_key: string | null;   // "movie/123" | "tv/456"
  title: string;
  timestamp: number;         // unix seconds
  season?: number | null;
  episode?: number | null;
  link?: string | null;
}

export interface SnapshotObservation {
  provider: Provider;
  first_seen_at: string;     // ISO
  added_after: string | null; // previous complete snapshot where absent; null → seen in baseline (undatable)
}

export interface EpisodeAir {
  season: number;
  episode: number;
  air_date: string;          // YYYY-MM-DD (TMDB; treated as IST date)
  season_episode_count?: number | null;
  runtime_min?: number | null;
}

export interface ArticleClaim {
  source_id: string | null;
  url: string;
  publisher: string | null;
  published_at: string | null;
  stated_platform: Provider | "other" | null;
  stated_date: string | null;  // YYYY-MM-DD as stated by the article
  quote: string;
}

export interface EvidenceOut {
  evidence_type: "availability_change" | "availability_snapshot" | "episode_air_date" | "availability_current" |
    "news_article" | "tmdb_digital_note" | "human_review";
  stance: "supports" | "conflicts" | "context";
  source_id?: string | null;
  url?: string | null;
  stated_date?: string | null;
  stated_platform?: string | null;
  quote?: string | null;
  detail?: Record<string, unknown>;
}

export interface VerifiedRelease {
  media_type: MediaType;
  tmdb_id: number;
  provider: Provider;
  release_type: ReleaseType;
  season_number: number | null;
  episode_number: number | null;
  available_date: string | null;   // IST date; null only while unresolved (needs_review)
  available_at: string | null;     // ISO when precise
  date_basis: DateBasis | null;
  verification_status: VerificationStatus;
  confidence: number;
  notes: string[];
  evidence: EvidenceOut[];
  watch_link?: string | null;
  episode_count?: number | null;
}

export interface Preferences {
  owner_name: string;
  genres: string[];
  languages: string[];
  platforms: Provider[];
  media_types: MediaType[];
  release_types: ReleaseType[];
  include_older_additions: boolean;
  notes?: string | null;
}
