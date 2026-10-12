-- Owner decision (2026-10-12): the dashboard is private to Naman. No anonymous reads at all;
-- every table is readable only by allow-listed admins (public.app_admins) signed in via Supabase Auth.

drop policy if exists releases_public_read on public.releases;
drop policy if exists evidence_read on public.release_evidence;
drop policy if exists recs_read on public.recommendations;
drop policy if exists sources_read on public.sources;
drop policy if exists runs_read on public.pipeline_runs;
drop policy if exists snapshot_runs_read on public.snapshot_runs;
drop policy if exists digest_runs_read on public.digest_runs;
drop policy if exists digest_items_read on public.digest_items;

create policy releases_admin_read on public.releases for select to authenticated using ((select private.is_admin()));
create policy evidence_admin_read on public.release_evidence for select to authenticated using ((select private.is_admin()));
create policy recs_admin_read on public.recommendations for select to authenticated using ((select private.is_admin()));
create policy sources_admin_read on public.sources for select to authenticated using ((select private.is_admin()));
create policy runs_admin_read on public.pipeline_runs for select to authenticated using ((select private.is_admin()));
create policy snapshot_runs_admin_read on public.snapshot_runs for select to authenticated using ((select private.is_admin()));
create policy digest_runs_admin_read on public.digest_runs for select to authenticated using ((select private.is_admin()));
create policy digest_items_admin_read on public.digest_items for select to authenticated using ((select private.is_admin()));

-- Belt and braces: the anon role gets no table privileges in public at all.
revoke all on all tables in schema public from anon;
alter default privileges in schema public revoke all on tables from anon;
revoke execute on function private.is_admin() from anon;
