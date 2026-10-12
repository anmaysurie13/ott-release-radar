-- Fixes from `supabase db advisors`:
--  * security definer is_admin() must not be callable through /rest/v1/rpc → move to the unexposed `private` schema
--  * evaluate auth.jwt() once per statement in RLS policies (initplan)

create or replace function private.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.app_admins a
    where a.email = (select lower(coalesce(auth.jwt() ->> 'email', '')))
  );
$$;
revoke all on function private.is_admin() from public;
grant usage on schema private to anon, authenticated;            -- schema is not exposed by the Data API
grant execute on function private.is_admin() to anon, authenticated;

drop policy prefs_admin_read on public.preferences;
drop policy prefs_admin_update on public.preferences;
drop policy releases_public_read on public.releases;
drop policy evidence_read on public.release_evidence;
drop policy recs_read on public.recommendations;
drop policy candidates_admin_read on public.candidates;
drop policy availability_admin_read on public.provider_availability;
drop policy delivery_admin_read on public.delivery_logs;
drop policy feedback_admin_read on public.feedback;
drop policy feedback_admin_insert on public.feedback;
drop policy admins_self_read on public.app_admins;
drop function public.is_admin();

create policy admins_self_read on public.app_admins for select to authenticated
  using (email = (select lower(coalesce(auth.jwt() ->> 'email', ''))));
create policy prefs_admin_read on public.preferences for select to authenticated using ((select private.is_admin()));
create policy prefs_admin_update on public.preferences for update to authenticated
  using ((select private.is_admin())) with check ((select private.is_admin()));
create policy releases_public_read on public.releases for select to anon, authenticated
  using (verification_status = 'confirmed' or (select private.is_admin()));
create policy evidence_read on public.release_evidence for select to anon, authenticated
  using (exists (select 1 from public.releases r where r.id = release_id
                 and (r.verification_status = 'confirmed' or (select private.is_admin()))));
create policy recs_read on public.recommendations for select to anon, authenticated
  using (exists (select 1 from public.releases r where r.id = release_id
                 and (r.verification_status = 'confirmed' or (select private.is_admin()))));
create policy candidates_admin_read on public.candidates for select to authenticated using ((select private.is_admin()));
create policy availability_admin_read on public.provider_availability for select to authenticated using ((select private.is_admin()));
create policy delivery_admin_read on public.delivery_logs for select to authenticated using ((select private.is_admin()));
create policy feedback_admin_read on public.feedback for select to authenticated using ((select private.is_admin()));
create policy feedback_admin_insert on public.feedback for insert to authenticated
  with check ((select private.is_admin()) and created_by = (select lower(auth.jwt() ->> 'email')));
