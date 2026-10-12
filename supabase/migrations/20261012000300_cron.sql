-- Scheduling: Supabase Cron (pg_cron) → pg_net → Edge Function `radar-cron`, authenticated with a shared secret.
-- All times are UTC. IST = UTC+05:30 (no DST).
--   Daily 06:00 IST  = 00:30 UTC          → snapshot (India availability snapshot for first-seen diff)
--   Fri   18:15 IST  = 12:45 UTC Fri      → snapshot (fresh baseline right before the digest)
--   Fri   18:30 IST  = 13:00 UTC Fri      → weekly (collect → verify → recommend → build → send)
--   Fri   18:45 / 19:00 / 19:30 IST       → weekly retries (idempotent: resume collect / resend only unsent chunks)
-- The secret and the functions base URL live in Supabase Vault; they are set once via
-- public.admin_configure_scheduler() (service_role only) — never in this file.

create extension if not exists pg_cron with schema pg_catalog;
create extension if not exists pg_net with schema extensions;

create or replace function public.admin_configure_scheduler(functions_url text, cron_secret text)
returns void language plpgsql security definer set search_path = '' as $$
declare sid uuid;
begin
  if functions_url !~ '^https://[a-z0-9]+\.supabase\.co/functions/v1$' then
    raise exception 'functions_url must look like https://<ref>.supabase.co/functions/v1';
  end if;
  if char_length(cron_secret) < 32 then raise exception 'cron_secret too short'; end if;

  select id into sid from vault.secrets where name = 'radar_functions_url';
  if sid is null then perform vault.create_secret(functions_url, 'radar_functions_url');
  else perform vault.update_secret(sid, functions_url); end if;

  select id into sid from vault.secrets where name = 'radar_cron_secret';
  if sid is null then perform vault.create_secret(cron_secret, 'radar_cron_secret');
  else perform vault.update_secret(sid, cron_secret); end if;
end $$;
revoke all on function public.admin_configure_scheduler(text, text) from public, anon, authenticated;
grant execute on function public.admin_configure_scheduler(text, text) to service_role;

create or replace function private.invoke_radar(task text) returns bigint
language plpgsql security definer set search_path = '' as $$
declare base text; secret text; req bigint;
begin
  select decrypted_secret into base from vault.decrypted_secrets where name = 'radar_functions_url';
  select decrypted_secret into secret from vault.decrypted_secrets where name = 'radar_cron_secret';
  if base is null or secret is null then
    raise warning 'radar scheduler not configured (vault secrets missing)';
    return null;
  end if;
  select net.http_post(
    url := base || '/radar-cron?task=' || task,
    headers := jsonb_build_object('content-type', 'application/json', 'x-cron-secret', secret),
    body := jsonb_build_object('task', task, 'trigger', 'cron'),
    timeout_milliseconds := 5000   -- fire-and-forget; the function keeps running and records its own run
  ) into req;
  return req;
end $$;
revoke all on function private.invoke_radar(text) from public, anon, authenticated;

-- (Re)create jobs idempotently.
do $$
declare j text;
begin
  foreach j in array array['radar-snapshot-daily', 'radar-snapshot-prefriday', 'radar-weekly',
                           'radar-weekly-retry-1', 'radar-weekly-retry-2', 'radar-weekly-retry-3'] loop
    if exists (select 1 from cron.job where jobname = j) then perform cron.unschedule(j); end if;
  end loop;
end $$;

select cron.schedule('radar-snapshot-daily',     '30 0 * * *',  $$select private.invoke_radar('snapshot')$$);
select cron.schedule('radar-snapshot-prefriday', '45 12 * * 5', $$select private.invoke_radar('snapshot')$$);
select cron.schedule('radar-weekly',             '0 13 * * 5',  $$select private.invoke_radar('weekly')$$);
select cron.schedule('radar-weekly-retry-1',     '15 13 * * 5', $$select private.invoke_radar('weekly')$$);
select cron.schedule('radar-weekly-retry-2',     '30 13 * * 5', $$select private.invoke_radar('weekly')$$);
select cron.schedule('radar-weekly-retry-3',     '0 14 * * 5',  $$select private.invoke_radar('weekly')$$);
