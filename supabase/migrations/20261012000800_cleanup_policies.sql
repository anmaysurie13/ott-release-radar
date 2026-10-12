-- Remove the superseded admin-only SELECT policies (advisor: multiple_permissive_policies).
-- Reads are public (read-only); writes go only through Edge Functions.
drop policy if exists releases_admin_read on public.releases;
drop policy if exists evidence_admin_read on public.release_evidence;
drop policy if exists recs_admin_read on public.recommendations;
drop policy if exists sources_admin_read on public.sources;
drop policy if exists runs_admin_read on public.pipeline_runs;
drop policy if exists snapshot_runs_admin_read on public.snapshot_runs;
drop policy if exists digest_runs_admin_read on public.digest_runs;
drop policy if exists digest_items_admin_read on public.digest_items;
drop policy if exists candidates_admin_read on public.candidates;
drop policy if exists delivery_admin_read on public.delivery_logs;
drop policy if exists feedback_admin_read on public.feedback;
drop policy if exists prefs_admin_read on public.preferences;

-- One-off extra digests requested by the owner: Mon 12 Oct and Tue 13 Oct 2026 at 18:30 IST (13:00 UTC),
-- each with a 15-minute retry. Date-guarded so they never fire again in later years.
do $$
declare j text;
begin
  foreach j in array array['radar-adhoc-1012', 'radar-adhoc-1012-retry', 'radar-adhoc-1013', 'radar-adhoc-1013-retry'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;
select cron.schedule('radar-adhoc-1012',       '0 13 12 10 *',  $$select private.invoke_radar('adhoc') where now() < '2026-10-14'$$);
select cron.schedule('radar-adhoc-1012-retry', '15 13 12 10 *', $$select private.invoke_radar('adhoc') where now() < '2026-10-14'$$);
select cron.schedule('radar-adhoc-1013',       '0 13 13 10 *',  $$select private.invoke_radar('adhoc') where now() < '2026-10-14'$$);
select cron.schedule('radar-adhoc-1013-retry', '15 13 13 10 *', $$select private.invoke_radar('adhoc') where now() < '2026-10-14'$$);
