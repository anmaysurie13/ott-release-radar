-- Streaming Availability returns at most 25 changes per page and we cap pages to protect the free quota
-- (1,000 req/month). India sees > 200 additions per week, so collect daily (newest-first) to capture every day's changes;
-- results are merged/deduplicated into the week's releases. ≈16 requests/day ≈ 480/month.
do $$ begin
  if exists (select 1 from cron.job where jobname = 'radar-collect-daily') then perform cron.unschedule('radar-collect-daily'); end if;
end $$;
select cron.schedule('radar-collect-daily', '45 0 * * *', $$select private.invoke_radar('collect')$$);  -- 06:15 IST
