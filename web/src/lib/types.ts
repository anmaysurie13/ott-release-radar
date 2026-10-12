export type Provider = "netflix" | "prime" | "jiohotstar";
export type MediaType = "movie" | "tv";
export type ReleaseType = "new_title" | "new_season" | "new_episode" | "older_addition";
export type Verdict = "watch" | "maybe" | "skip";
export type DateBasis = "sa_change" | "snapshot_first_seen" | "tmdb_episode_air_date" | "human_review";

export interface Recommendation {
  id: string;
  verdict: Verdict;
  score: number;
  reason: string;
  synopsis: string;
  model: string;
  is_fallback: boolean;
  created_at: string;
  preferences_hash: string;
}

export interface Evidence {
  id?: string;
  evidence_type: string;
  stance: "supports" | "conflicts" | "context";
  url: string | null;
  stated_date: string | null;
  stated_platform?: string | null;
  quote: string | null;
  detail: Record<string, unknown>;
  observed_at?: string;
}

export interface Release {
  id: string;
  media_type: MediaType;
  tmdb_id: number;
  provider: Provider;
  release_type: ReleaseType;
  season_number: number | null;
  episode_number: number | null;
  episode_count: number | null;
  available_date: string | null;
  available_at: string | null;
  date_basis: DateBasis | null;
  verification_status: "confirmed" | "needs_review" | "excluded";
  verification_notes: string | null;
  confidence: number;
  title: string;
  original_language: string | null;
  spoken_languages: string[];
  genres: string[];
  overview: string | null;
  poster_path: string | null;
  backdrop_path: string | null;
  year: number | null;
  runtime_min: number | null;
  watch_link: string | null;
  last_checked_at: string;
  recommendations: Recommendation[];
  release_evidence: Evidence[];
}

export interface Preferences {
  owner_name: string;
  genres: string[];
  languages: string[];
  platforms: Provider[];
  media_types: MediaType[];
  release_types: ReleaseType[];
  include_older_additions: boolean;
  notes: string | null;
  digest_enabled: boolean;
  updated_at?: string;
}

export interface PipelineRun {
  id: string;
  task: string;
  trigger: string;
  status: string;
  window_key: string | null;
  started_at: string;
  finished_at: string | null;
  error: string | null;
  stats: Record<string, number | string | boolean>;
  source_health: Record<string, string>;
}

export interface DigestRun {
  id: string;
  window_key: string;
  is_test: boolean;
  status: string;
  chunk_count: number;
  item_count: number;
  created_at: string;
  sent_at: string | null;
  error: string | null;
}

export interface Source {
  id: string;
  kind: string;
  url: string;
  title: string | null;
  publisher: string | null;
  published_at: string | null;
  fetched_at: string;
}
