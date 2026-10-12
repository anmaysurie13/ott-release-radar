-- Owner decision (2026-10-12, later): no email sign-in. Anyone with the link may VIEW the dashboard (read-only).
-- All writes stay server-side: the pipeline (service role) and radar-api, which requires the OWNER_CODE secret.

grant select on public.releases, public.release_evidence, public.recommendations, public.sources, public.candidates,
  public.pipeline_runs, public.snapshot_runs, public.digest_runs, public.digest_items, public.delivery_logs,
  public.preferences, public.feedback to anon, authenticated;

create policy releases_view on public.releases for select to anon, authenticated using (true);
create policy evidence_view on public.release_evidence for select to anon, authenticated using (true);
create policy recs_view on public.recommendations for select to anon, authenticated using (true);
create policy sources_view on public.sources for select to anon, authenticated using (true);
create policy candidates_view on public.candidates for select to anon, authenticated using (true);
create policy runs_view on public.pipeline_runs for select to anon, authenticated using (true);
create policy snapshot_runs_view on public.snapshot_runs for select to anon, authenticated using (true);
create policy digest_runs_view on public.digest_runs for select to anon, authenticated using (true);
create policy digest_items_view on public.digest_items for select to anon, authenticated using (true);
create policy delivery_view on public.delivery_logs for select to anon, authenticated using (true);
create policy prefs_view on public.preferences for select to anon, authenticated using (true);
create policy feedback_view on public.feedback for select to anon, authenticated using (true);

-- Browsers never write directly any more (preferences/feedback go through radar-api with the owner code).
drop policy if exists prefs_admin_update on public.preferences;
drop policy if exists feedback_admin_insert on public.feedback;
revoke insert, update, delete on all tables in schema public from anon, authenticated;
-- provider_availability (snapshot internals) and app_admins stay private.
