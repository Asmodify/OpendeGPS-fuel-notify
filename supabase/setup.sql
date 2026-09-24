-- Least-privilege database login for the Vercel functions. Run once in the Supabase SQL editor
-- AFTER supabase/migrations/0001_fuel.sql, with the placeholder replaced by a long random
-- password (e.g. openssl rand -base64 32 | tr -d '/+='). Never commit the real password.
--
-- DATABASE_URL for Vercel then uses the transaction pooler (port 6543) with this role:
--   postgresql://fuel_app.<project-ref>:<password>@aws-0-<region>.pooler.supabase.com:6543/postgres
-- (copy host / user format from Supabase > Connect > Transaction pooler, and put fuel_app in
-- place of postgres).

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'fuel_app') then
    create role fuel_app login password 'CHANGE_ME_LONG_RANDOM_PASSWORD' noinherit;
  else
    alter role fuel_app login password 'CHANGE_ME_LONG_RANDOM_PASSWORD';
  end if;
end $$;

alter role fuel_app set search_path = fuel;
alter role fuel_app set statement_timeout = '30s';

-- only the fuel schema, only data changes (no DDL, no other schemas)
grant usage on schema fuel to fuel_app;
grant select, insert, update, delete on all tables in schema fuel to fuel_app;
alter default privileges in schema fuel grant select, insert, update, delete on tables to fuel_app;
grant execute on function fuel.prune() to fuel_app;

-- RLS is on for every table (0001_fuel.sql); this role is the only one with a policy
do $$
declare
  t text;
begin
  foreach t in array array['vehicles', 'samples', 'levels', 'alerts', 'settings', 'calibrations',
                           'detector_state', 'poller_state', 'tick_lease', 'login_attempts']
  loop
    execute format('drop policy if exists fuel_app_all on fuel.%I', t);
    execute format('create policy fuel_app_all on fuel.%I for all to fuel_app using (true) with check (true)', t);
  end loop;
end $$;
