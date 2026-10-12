-- Row Level Security.
-- Public (anon) may read only CONFIRMED releases and their AI opinions/sources, which is what the dashboard shows.
-- Allowlisted admins (Naman / operator, signed in via Supabase Auth) can also read the review queue, preferences,
-- delivery logs and feedback, and can edit preferences and feedback.
-- All pipeline writes use the service-role key inside Edge Functions (bypasses RLS; never shipped to the browser).

create schema if not exists private;
revoke all on schema private from public, anon, authenticated;

create or replace function public.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_admins a
    where a.email = lower(coalesce((select auth.jwt() ->> 'email'), ''))
  );
$$;
revoke all on function public.is_admin() from public;
grant execute on function public.is_admin() to anon, authenticated;

alter table public.app_admins enable row level security;
alter table public.preferences enable row level security;
alter table public.pipeline_runs enable row level security;
alter table public.snapshot_runs enable row level security;
alter table public.provider_availability enable row level security;
alter table public.sources enable row level security;
alter table public.releases enable row level security;
alter table public.release_evidence enable row level security;
alter table public.candidates enable row level security;
alter table public.recommendations enable row level security;
alter table public.digest_runs enable row level security;
alter table public.digest_items enable row level security;
alter table public.delivery_logs enable row level security;
alter table public.feedback enable row level security;

-- admins: see own row only (used by the UI to know if editing is allowed)
create policy admins_self_read on public.app_admins for select to authenticated
  using (email = lower(coalesce((select auth.jwt() ->> 'email'), '')));

-- preferences: admin read/update
create policy prefs_admin_read on public.preferences for select to authenticated using ((select public.is_admin()));
create policy prefs_admin_update on public.preferences for update to authenticated
  using ((select public.is_admin())) with check ((select public.is_admin()));

-- releases: confirmed are public; everything (incl. review queue) for admins
create policy releases_public_read on public.releases for select to anon, authenticated
  using (verification_status = 'confirmed' or (select public.is_admin()));

create policy evidence_read on public.release_evidence for select to anon, authenticated
  using (exists (select 1 from public.releases r where r.id = release_id
                 and (r.verification_status = 'confirmed' or (select public.is_admin()))));

create policy recs_read on public.recommendations for select to anon, authenticated
  using (exists (select 1 from public.releases r where r.id = release_id
                 and (r.verification_status = 'confirmed' or (select public.is_admin()))));

create policy sources_read on public.sources for select to anon, authenticated using (true);
create policy runs_read on public.pipeline_runs for select to anon, authenticated using (true);
create policy snapshot_runs_read on public.snapshot_runs for select to anon, authenticated using (true);
create policy digest_runs_read on public.digest_runs for select to anon, authenticated using (true);
create policy digest_items_read on public.digest_items for select to anon, authenticated using (true);

create policy candidates_admin_read on public.candidates for select to authenticated using ((select public.is_admin()));
create policy availability_admin_read on public.provider_availability for select to authenticated using ((select public.is_admin()));
create policy delivery_admin_read on public.delivery_logs for select to authenticated using ((select public.is_admin()));

create policy feedback_admin_read on public.feedback for select to authenticated using ((select public.is_admin()));
create policy feedback_admin_insert on public.feedback for insert to authenticated
  with check ((select public.is_admin()) and created_by = lower((select auth.jwt() ->> 'email')));

-- Tighten default grants: browsers never write pipeline tables directly.
revoke insert, update, delete on all tables in schema public from anon;
revoke insert, update, delete on public.releases, public.release_evidence, public.sources, public.candidates,
  public.recommendations, public.digest_runs, public.digest_items, public.delivery_logs, public.pipeline_runs,
  public.snapshot_runs, public.provider_availability, public.app_admins from authenticated;
revoke insert, delete on public.preferences from authenticated;
