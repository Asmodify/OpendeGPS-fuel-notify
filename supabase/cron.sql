-- Supabase pg_cron schedule: calls the Vercel function every minute (Vercel Hobby crons only
-- run daily) and prunes old data once a day. Run in the Supabase SQL editor after
-- 0001_fuel.sql, with the two placeholders replaced. The URL and the secret live in Supabase
-- Vault, not in the job text.
create extension if not exists pg_cron;
create extension if not exists pg_net;

-- 1) secrets (run once; to change one later use vault.update_secret)
select vault.create_secret('https://YOUR-PROJECT.vercel.app', 'fuel_tick_url', 'Fuel Tank Warner base URL');
select vault.create_secret('CHANGE_ME_SAME_AS_VERCEL_CRON_SECRET', 'fuel_cron_secret', 'Bearer token for /api/cron/tick');

-- 2) jobs (cron.schedule with an existing name replaces that job)
select cron.schedule(
  'fuel-tick',
  '* * * * *',
  $$
  select net.http_post(
    url := (select decrypted_secret from vault.decrypted_secrets where name = 'fuel_tick_url') || '/api/cron/tick',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || (select decrypted_secret from vault.decrypted_secrets where name = 'fuel_cron_secret')
    ),
    body := '{}'::jsonb,
    timeout_milliseconds := 60000
  );
  $$
);

select cron.schedule('fuel-prune', '17 19 * * *', $$ select fuel.prune(); $$); -- 03:17 in Ulaanbaatar

-- check:   select * from cron.job;
--          select * from cron.job_run_details order by start_time desc limit 10;
--          select id, status_code, left(content::text, 200) from net._http_response order by id desc limit 10;
-- pause:   select cron.unschedule('fuel-tick');
