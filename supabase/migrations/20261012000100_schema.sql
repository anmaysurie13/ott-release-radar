-- OTT Release Radar — core schema.
-- Facts (releases, evidence, sources) are kept separate from AI opinions (recommendations).

create extension if not exists pgcrypto with schema extensions;

-- ---------- enums ----------
create type public.provider_code as enum ('netflix', 'prime', 'jiohotstar');
create type public.media_kind as enum ('movie', 'tv');
create type public.release_kind as enum ('new_title', 'new_season', 'new_episode', 'older_addition');
create type public.verification_state as enum ('confirmed', 'needs_review', 'excluded');
create type public.date_basis as enum (
  'sa_change',            -- Streaming Availability /changes timestamp (country=in)
  'snapshot_first_seen',  -- first observed in our TMDB/JustWatch India snapshot diff
  'tmdb_episode_air_date',-- TMDB episode air date for a platform-original series that is available in IN
  'human_review'          -- confirmed by the owner in the review queue
);
create type public.verdict as enum ('watch', 'maybe', 'skip');
create type public.run_status as enum ('running', 'succeeded', 'partial', 'failed', 'skipped');

-- ---------- access ----------
-- Emails allowed to edit preferences / review / trigger test sends from the dashboard.
create table public.app_admins (
  email text primary key check (email = lower(email) and position('@' in email) > 1),
  role text not null default 'owner' check (role in ('owner', 'operator')),
  created_at timestamptz not null default now()
);

-- ---------- preferences ----------
create table public.preferences (
  id smallint primary key default 1 check (id = 1),           -- single-user product
  owner_name text not null default 'Naman',
  genres text[] not null default array['Thriller', 'Science Fiction', 'Indie Drama'],
  languages text[] not null default array['hi', 'en', 'ta'],  -- ISO 639-1
  platforms public.provider_code[] not null default array['netflix', 'prime', 'jiohotstar']::public.provider_code[],
  media_types public.media_kind[] not null default array['movie', 'tv']::public.media_kind[],
  release_types public.release_kind[] not null default array['new_title', 'new_season', 'new_episode']::public.release_kind[],
  include_older_additions boolean not null default false,
  notes text check (char_length(notes) <= 500),
  digest_enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint prefs_nonempty check (cardinality(platforms) > 0 and cardinality(media_types) > 0)
);
insert into public.preferences (id) values (1);

-- ---------- pipeline runs ----------
create table public.pipeline_runs (
  id uuid primary key default gen_random_uuid(),
  task text not null check (task in ('snapshot', 'collect', 'deliver', 'weekly', 'manual_collect', 'preview', 'test_send')),
  trigger text not null check (trigger in ('cron', 'manual', 'api')),
  window_key text,                       -- e.g. '2026-10-16' (Friday of the window end, IST)
  window_start timestamptz,
  window_end timestamptz,
  status public.run_status not null default 'running',
  stats jsonb not null default '{}'::jsonb,
  source_health jsonb not null default '{}'::jsonb,  -- per-source status, e.g. {"streaming_availability":"403 not subscribed"}
  error text,
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index pipeline_runs_started_idx on public.pipeline_runs (started_at desc);
create index pipeline_runs_task_window_idx on public.pipeline_runs (task, window_key);

-- ---------- availability snapshots (fallback verification) ----------
create table public.snapshot_runs (
  id uuid primary key default gen_random_uuid(),
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  complete boolean not null default false,   -- only complete runs may be used to infer "absent"
  is_baseline boolean not null default false,
  pages_fetched int not null default 0,
  titles_seen int not null default 0,
  new_titles int not null default 0,
  error text
);
create index snapshot_runs_complete_idx on public.snapshot_runs (complete, started_at desc);

create table public.provider_availability (
  provider public.provider_code not null,
  media_type public.media_kind not null,
  tmdb_id int not null,
  region text not null default 'IN' check (region = 'IN'),
  first_seen_at timestamptz not null,
  first_seen_run uuid references public.snapshot_runs(id) on delete set null,
  added_after timestamptz,          -- previous complete snapshot where it was absent (null = present in baseline → undatable)
  last_seen_at timestamptz not null,
  primary key (provider, media_type, tmdb_id, region)
);
create index provider_availability_first_seen_idx on public.provider_availability (first_seen_at desc) where added_after is not null;

-- ---------- sources (articles, API responses) ----------
create table public.sources (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('news_rss', 'publisher_rss', 'streaming_availability', 'tmdb', 'snapshot')),
  url text not null,
  title text,
  publisher text,
  published_at timestamptz,       -- publication date — NOT a release date
  snippet text check (char_length(snippet) <= 2000),
  query text,
  fetched_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  constraint sources_url_unique unique (url)
);
create index sources_published_idx on public.sources (published_at desc);

-- ---------- releases (verified facts) ----------
create table public.releases (
  id uuid primary key default gen_random_uuid(),
  media_type public.media_kind not null,
  tmdb_id int not null,
  provider public.provider_code not null,
  release_type public.release_kind not null,
  season_number int check (season_number >= 0),
  episode_number int check (episode_number >= 0),
  -- media:tmdb:provider:type:season:episode:date — computed by the pipeline (dedupe.ts); also enforced by releases_dedupe_uidx
  dedupe_key text not null constraint releases_dedupe_key_unique unique,
  available_date date,                     -- IST calendar date of availability in India (null only while unresolved)
  available_at timestamptz,                -- precise timestamp when the source provides one
  date_basis public.date_basis,
  verification_status public.verification_state not null default 'needs_review',
  verification_notes text,
  confidence numeric(3,2) not null default 0 check (confidence between 0 and 1),
  -- metadata (TMDB)
  title text not null,
  original_title text,
  original_language text,
  spoken_languages text[] not null default '{}',
  genres text[] not null default '{}',
  overview text,
  poster_path text,
  backdrop_path text,
  year int,
  runtime_min int check (runtime_min > 0),
  episode_count int check (episode_count >= 0),
  watch_link text,                          -- JustWatch/TMDB or Streaming Availability deep link
  reviewed_by text,
  reviewed_at timestamptz,
  first_detected_at timestamptz not null default now(),
  last_checked_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint confirmed_has_date check (verification_status <> 'confirmed' or (available_date is not null and date_basis is not null))
);
-- Deduplicate by title (tmdb id) / provider / release type / date (season & episode are part of identity for TV).
create unique index releases_dedupe_uidx on public.releases
  (media_type, tmdb_id, provider, release_type, coalesce(season_number, -1), coalesce(episode_number, -1), coalesce(available_date, '1970-01-01'::date));
create index releases_window_idx on public.releases (available_date desc, verification_status);
create index releases_status_idx on public.releases (verification_status) where verification_status = 'needs_review';

create table public.release_evidence (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.releases(id) on delete cascade,
  source_id uuid references public.sources(id) on delete set null,
  evidence_type text not null check (evidence_type in
    ('availability_change', 'availability_snapshot', 'episode_air_date', 'availability_current',
     'news_article', 'tmdb_digital_note', 'human_review')),
  stance text not null default 'supports' check (stance in ('supports', 'conflicts', 'context')),
  stated_date date,
  stated_platform text,
  quote text check (char_length(quote) <= 600),
  url text,
  detail jsonb not null default '{}'::jsonb,
  observed_at timestamptz not null default now()
);
create index release_evidence_release_idx on public.release_evidence (release_id);
create unique index release_evidence_dedupe_uidx on public.release_evidence
  (release_id, evidence_type, coalesce(source_id, '00000000-0000-0000-0000-000000000000'::uuid), coalesce(stated_date, '1970-01-01'::date));

-- ---------- candidates extracted from articles (discovery only) ----------
create table public.candidates (
  id uuid primary key default gen_random_uuid(),
  run_id uuid references public.pipeline_runs(id) on delete set null,
  source_id uuid references public.sources(id) on delete cascade,
  raw_title text not null,
  stated_platform text,
  stated_release_date date,
  release_type_hint text,
  evidence_quote text check (char_length(evidence_quote) <= 600),
  tmdb_id int,
  media_type public.media_kind,
  match_confidence numeric(3,2) check (match_confidence between 0 and 1),
  match_status text not null default 'unmatched' check (match_status in ('matched', 'ambiguous', 'unmatched')),
  release_id uuid references public.releases(id) on delete set null,
  created_at timestamptz not null default now()
);
create index candidates_run_idx on public.candidates (run_id);
alter table public.candidates add constraint candidates_source_title_unique unique (source_id, raw_title);

-- ---------- recommendations (AI opinion) ----------
create table public.recommendations (
  id uuid primary key default gen_random_uuid(),
  release_id uuid not null references public.releases(id) on delete cascade,
  preferences_hash text not null,
  verdict public.verdict not null,
  score int not null check (score between 0 and 100),
  reason text not null check (char_length(reason) between 1 and 280),
  synopsis text not null check (char_length(synopsis) between 1 and 320),
  model text not null,                -- e.g. 'gemini-2.5-flash' or 'rules-fallback'
  is_fallback boolean not null default false,
  created_at timestamptz not null default now(),
  constraint recommendations_unique unique (release_id, preferences_hash)
);
create index recommendations_release_idx on public.recommendations (release_id, created_at desc);

-- ---------- digests ----------
create table public.digest_runs (
  id uuid primary key default gen_random_uuid(),
  window_key text not null,
  window_start timestamptz not null,
  window_end timestamptz not null,
  is_test boolean not null default false,
  status text not null default 'built' check (status in ('built', 'sending', 'sent', 'partial', 'failed', 'needs_attention')),
  chunk_count int not null default 0,
  chunks text[] not null default '{}',
  item_count int not null default 0,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  error text
);
-- Exactly one scheduled (non-test) digest per window — the core duplicate-send guard.
create unique index digest_runs_one_per_window_uidx on public.digest_runs (window_key) where not is_test;
create index digest_runs_created_idx on public.digest_runs (created_at desc);

create table public.digest_items (
  digest_run_id uuid not null references public.digest_runs(id) on delete cascade,
  release_id uuid not null references public.releases(id) on delete cascade,
  recommendation_id uuid references public.recommendations(id) on delete set null,
  section text not null check (section in ('top', 'more', 'older', 'skipped')),
  position int not null,
  primary key (digest_run_id, release_id)
);

create table public.delivery_logs (
  id uuid primary key default gen_random_uuid(),
  digest_run_id uuid not null references public.digest_runs(id) on delete cascade,
  chunk_index int not null check (chunk_index >= 0),
  channel text not null default 'telegram',
  chat_ref text not null,             -- sha256 prefix of chat id, never the raw id
  status text not null check (status in ('sending', 'sent', 'failed', 'unknown')),
  attempts int not null default 0,
  telegram_message_id bigint,
  http_status int,
  error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint delivery_logs_chunk_unique unique (digest_run_id, chunk_index, chat_ref)
);

-- ---------- feedback (impact measurement) ----------
create table public.feedback (
  id uuid primary key default gen_random_uuid(),
  release_id uuid references public.releases(id) on delete cascade,
  decision text check (decision in ('watched', 'watchlist', 'not_interested', 'wrong_info')),
  minutes_saved int check (minutes_saved between 0 and 240),
  note text check (char_length(note) <= 500),
  created_by text,
  created_at timestamptz not null default now()
);
create index feedback_release_idx on public.feedback (release_id);

-- updated_at helpers
create or replace function public.touch_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;
create trigger releases_touch before update on public.releases for each row execute function public.touch_updated_at();
create trigger preferences_touch before update on public.preferences for each row execute function public.touch_updated_at();
create trigger delivery_logs_touch before update on public.delivery_logs for each row execute function public.touch_updated_at();

-- Bulk refresh of last_seen_at for the snapshot job (service_role only).
create or replace function public.radar_touch_availability(p public.provider_code, m public.media_kind, ids int[], seen_at timestamptz)
returns int language sql security definer set search_path = '' as $$
  with u as (
    update public.provider_availability set last_seen_at = seen_at
    where provider = p and media_type = m and region = 'IN' and tmdb_id = any(ids)
    returning 1)
  select count(*)::int from u;
$$;
revoke all on function public.radar_touch_availability(public.provider_code, public.media_kind, int[], timestamptz) from public, anon, authenticated;
grant execute on function public.radar_touch_availability(public.provider_code, public.media_kind, int[], timestamptz) to service_role;
