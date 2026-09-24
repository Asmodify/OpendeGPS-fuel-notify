-- Fuel Tank Warner (cloud version): tables in their own schema "fuel", so nothing is exposed
-- through Supabase's Data API (which serves the "public" schema). Safe to run more than once.
-- Times are milliseconds since 1970 UTC (bigint), like the local SQLite database.

create schema if not exists fuel;

-- last known state of each tracker (USER_GET_OBJECTS); rec = the backend's per-vehicle state
-- between ticks, det_state = the detector's getState() after its last run
create table if not exists fuel.vehicles (
  imei text primary key,
  name text, group_name text, device text, plate text, sim text,
  has_fuel boolean not null default false,
  last_seen bigint, server_seen bigint,
  lat double precision, lng double precision, speed double precision, angle double precision,
  ign smallint, pwr double precision, fuel_raw double precision, odometer_km double precision,
  status text,
  updated_at bigint,
  rec jsonb,
  det_state jsonb
);

-- raw tracker messages, kept 3 days
create table if not exists fuel.samples (
  imei text not null,
  t bigint not null,
  f double precision, spd double precision, ign smallint, pwr double precision,
  lat double precision, lng double precision, odo double precision,
  primary key (imei, t)
);
create index if not exists samples_t on fuel.samples (t);

-- trusted fuel levels from the detector, kept 90 days
create table if not exists fuel.levels (
  imei text not null,
  t bigint not null,
  mv double precision not null,
  primary key (imei, t)
);
create index if not exists levels_t on fuel.levels (t);

-- alerts; unique key de-duplicates; refuel / fuel_drain (the fuel ledger) are never pruned.
-- id is assigned by the tick (the only writer of new alerts, under the tick lease).
create table if not exists fuel.alerts (
  id bigint primary key,
  key text not null unique,
  imei text,
  name text,
  type text not null,
  severity text not null,
  t bigint not null,
  from_t bigint,
  lat double precision, lng double precision,
  title text, detail text,
  amount_mv double precision,
  ongoing boolean not null default false,
  acked boolean not null default false,
  acked_at bigint,
  historical boolean not null default false,
  extra text,
  verdict text,
  note text,
  reviewed_at bigint,
  created_at bigint not null,
  updated_at bigint not null
);
create index if not exists alerts_t on fuel.alerts (t);
create index if not exists alerts_imei_t on fuel.alerts (imei, t);
create index if not exists alerts_unacked on fuel.alerts (imei, severity) where not acked;
create index if not exists alerts_ongoing on fuel.alerts (imei, type) where ongoing;
create index if not exists alerts_type_t on fuel.alerts (type, t);

-- dashboard settings: 'global' (thresholds, notify) and 'vehicle:<imei>' (cal, th, muted)
create table if not exists fuel.settings (
  k text primary key,
  v jsonb not null
);

-- tank calibration tables from the GPS server: [[mV, litres], ...] per tracker
create table if not exists fuel.calibrations (
  imei text primary key,
  points jsonb not null,
  updated_at timestamptz not null default now()
);

-- each vehicle's detector, saved after every tick that fed it (VehicleDetector.snapshot())
create table if not exists fuel.detector_state (
  imei text primary key,
  ver bigint not null default 1,
  snap jsonb not null,
  updated_at bigint
);

-- poller status (last polls, call-limit pause, backfill progress); ver changes on every write
create table if not exists fuel.poller_state (
  id int primary key default 1 check (id = 1),
  state jsonb not null default '{}'::jsonb,
  ver bigint not null default 0
);
insert into fuel.poller_state (id) values (1) on conflict (id) do nothing;

-- one tick at a time (advisory locks do not survive the transaction pooler)
create table if not exists fuel.tick_lease (
  id int primary key default 1 check (id = 1),
  holder text,
  until timestamptz,
  started timestamptz
);
insert into fuel.tick_lease (id) values (1) on conflict (id) do nothing;

-- failed dashboard logins (rate limit per IP)
create table if not exists fuel.login_attempts (
  ip text not null,
  at timestamptz not null default now()
);
create index if not exists login_attempts_ip_at on fuel.login_attempts (ip, at);

-- Row level security on and no policy for anyone here: the Data API roles (anon /
-- authenticated) can read or change nothing even if the schema were ever exposed. The app's
-- own login role gets its grants and one policy per table in supabase/setup.sql.
alter table fuel.vehicles enable row level security;
alter table fuel.samples enable row level security;
alter table fuel.levels enable row level security;
alter table fuel.alerts enable row level security;
alter table fuel.settings enable row level security;
alter table fuel.calibrations enable row level security;
alter table fuel.detector_state enable row level security;
alter table fuel.poller_state enable row level security;
alter table fuel.tick_lease enable row level security;
alter table fuel.login_attempts enable row level security;

-- nothing in this schema for the Data API roles
revoke all on schema fuel from public;
do $$
begin
  if exists (select 1 from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema fuel from anon, authenticated';
    execute 'revoke all on all tables in schema fuel from anon, authenticated';
  end if;
end $$;

-- daily clean-up (scheduled by supabase/cron.sql): samples 3 days, levels and alerts 90 days,
-- refuels and fuel drains (the fuel ledger) forever
create or replace function fuel.prune() returns jsonb
language plpgsql
set search_path = fuel, pg_temp
as $$
declare
  now_ms bigint := (extract(epoch from now()) * 1000)::bigint;
  n_samples bigint;
  n_levels bigint;
  n_alerts bigint;
begin
  delete from fuel.samples where t < now_ms - 72 * 3600000::bigint;
  get diagnostics n_samples = row_count;
  delete from fuel.levels where t < now_ms - 90 * 86400000::bigint;
  get diagnostics n_levels = row_count;
  delete from fuel.alerts where t < now_ms - 90 * 86400000::bigint and type not in ('refuel', 'fuel_drain');
  get diagnostics n_alerts = row_count;
  delete from fuel.login_attempts where at < now() - interval '1 day';
  return jsonb_build_object('samples', n_samples, 'levels', n_levels, 'alerts', n_alerts);
end $$;
revoke all on function fuel.prune() from public;
