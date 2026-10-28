-- Hebammen Lounge | Single-practice reservation backend
-- Apply once via Supabase SQL Editor in a NEW project, using the postgres owner.
-- No patient/medical data. Prices below are GROSS cents.
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users(id) on delete restrict,
  email text not null default '',
  display_name text not null default '' check (char_length(display_name) <= 120),
  role text not null default 'colleague' check (role in ('colleague','admin')),
  active boolean not null default false,
  created_at timestamptz not null default now()
);

create table public.tariffs (
  kind text primary key check (kind in ('hourly','day','weekend')),
  gross_cents integer not null check (gross_cents > 0)
);
insert into public.tariffs(kind,gross_cents) values
 ('hourly',1600),('day',12000),('weekend',30000);

create table public.reservations (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid references public.profiles(id) on delete restrict,
  kind text not null check (kind in ('hourly','day','weekend','block')),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  gross_cents integer not null check (gross_cents >= 0),
  status text not null default 'confirmed' check (status in ('confirmed','cancelled')),
  note text not null default '' check (char_length(note) <= 160),
  created_by uuid references auth.users(id) on delete restrict,
  created_at timestamptz not null default now(),
  cancelled_at timestamptz,
  constraint reservation_valid_times check (ends_at > starts_at),
  constraint reservation_kind_owner check (
    (kind = 'block' and profile_id is null and gross_cents = 0) or
    (kind <> 'block' and profile_id is not null)
  ),
  constraint reservation_time_conflict exclude using gist (
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'confirmed')
);
create index reservations_owner_index on public.reservations (profile_id, starts_at desc);
create index reservations_starts_index on public.reservations (starts_at);

create or replace function private.create_profile()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles(id,email)
  values (new.id, coalesce(new.email,''))
  on conflict (id) do nothing;
  return new;
end;
$$;
create trigger after_auth_signup
  after insert on auth.users for each row execute function private.create_profile();

create or replace function private.is_active()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p where p.id = (select auth.uid()) and p.active);
$$;
create or replace function private.is_admin()
returns boolean language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles p
    where p.id = (select auth.uid()) and p.active and p.role = 'admin');
$$;

alter table public.profiles enable row level security;
alter table public.tariffs enable row level security;
alter table public.reservations enable row level security;

-- Explicitly zero direct write grants. All changes must use reviewed RPC functions.
revoke all on public.profiles, public.tariffs, public.reservations from anon, authenticated;
grant select on public.profiles, public.tariffs, public.reservations to authenticated;

create policy profiles_read_self_or_admin on public.profiles for select to authenticated
 using (id = (select auth.uid()) or (select private.is_admin()));
create policy tariffs_authenticated_read on public.tariffs for select to authenticated
 using (true);
create policy reservations_read_only_mine_or_admin on public.reservations for select to authenticated
 using (profile_id = (select auth.uid()) or (select private.is_admin()));

-- Own name only. Not a generic profile update: prevents role/active/email spoofing.
create or replace function public.update_my_name(p_name text)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if (select auth.uid()) is null then raise exception 'Bitte anmelden.' using errcode='42501'; end if;
  if p_name is null or length(btrim(p_name)) < 2 or length(btrim(p_name)) > 120
    then raise exception 'Name: 2 bis 120 Zeichen.' using errcode='22023'; end if;
  update public.profiles set display_name = btrim(p_name) where id = (select auth.uid());
end;
$$;

-- Only time ranges, never names/emails of other colleagues.
create or replace function public.busy_slots(p_from date, p_to date)
returns table(starts_at timestamptz, ends_at timestamptz)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not (select private.is_active()) then raise exception 'Zugang noch nicht freigegeben.' using errcode='42501'; end if;
  if p_from is null or p_to is null or p_to < p_from or p_to > p_from + 62
    then raise exception 'Ungültiger Kalenderzeitraum.' using errcode='22023'; end if;
  return query select r.starts_at, r.ends_at from public.reservations r
  where r.status='confirmed'
    and r.starts_at < ((p_to + 1)::timestamp at time zone 'Europe/Berlin')
    and r.ends_at > (p_from::timestamp at time zone 'Europe/Berlin')
  order by r.starts_at;
end;
$$;

-- Transactional, authoritative price/clock checks; exclusion constraint prevents races.
create or replace function public.book_practice(
  p_kind text, p_day date, p_start_time time default null,
  p_hours integer default null, p_for_user uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_actor uuid := (select auth.uid());
  v_target uuid;
  v_admin boolean := (select private.is_admin());
  v_start timestamptz;
  v_end timestamptz;
  v_price integer;
  v_id uuid;
begin
  if not (select private.is_active()) then raise exception 'Zugang noch nicht freigegeben.' using errcode='42501'; end if;
  if p_day is null or p_day < (now() at time zone 'Europe/Berlin')::date
      or p_day > ((now() at time zone 'Europe/Berlin')::date + 730)
    then raise exception 'Datum muss innerhalb der nächsten zwei Jahre liegen.' using errcode='22023'; end if;
  if p_kind not in ('hourly','day','weekend') or p_kind is null
    then raise exception 'Unbekannte Buchungsart.' using errcode='22023'; end if;
  if p_for_user is not null and p_for_user <> v_actor and not v_admin
    then raise exception 'Keine Berechtigung für fremde Buchungen.' using errcode='42501'; end if;
  v_target := coalesce(p_for_user, v_actor);
  if not exists (select 1 from public.profiles p where p.id=v_target
                 and p.active and length(btrim(p.display_name))>=2)
    then raise exception 'Kollegin nicht freigeschaltet oder Name fehlt.' using errcode='42501'; end if;
  if p_kind = 'hourly' then
    if p_start_time is null or p_hours is null or p_hours not between 1 and 14
      or extract(minute from p_start_time) <> 0 or extract(second from p_start_time) <> 0
      or extract(hour from p_start_time) < 8
      or extract(hour from p_start_time) + p_hours > 22
      then raise exception 'Stundenweise nur volle Stunden zwischen 08:00 und 22:00 Uhr.' using errcode='22023'; end if;
    v_start := (p_day + p_start_time) at time zone 'Europe/Berlin';
    v_end := (p_day + p_start_time + make_interval(hours => p_hours)) at time zone 'Europe/Berlin';
  elsif p_kind = 'day' then
    if p_start_time is not null or p_hours is not null
      then raise exception 'Bei Tagesbuchung keine Stunden angeben.' using errcode='22023'; end if;
    v_start := (p_day + time '08:00') at time zone 'Europe/Berlin';
    v_end := (p_day + time '22:00') at time zone 'Europe/Berlin';
  else
    if extract(isodow from p_day) <> 6 or p_start_time is not null or p_hours is not null
      then raise exception 'Wochenendbuchung beginnt Samstag um 08:00 Uhr.' using errcode='22023'; end if;
    v_start := (p_day + time '08:00') at time zone 'Europe/Berlin';
    v_end := (p_day + 1 + time '22:00') at time zone 'Europe/Berlin';
  end if;
  if v_start <= now() then raise exception 'Der Buchungsbeginn liegt in der Vergangenheit.' using errcode='22023'; end if;
  select gross_cents into v_price from public.tariffs where kind=p_kind;
  if v_price is null then raise exception 'Tarif nicht verfügbar.' using errcode='22023'; end if;
  if p_kind='hourly' then v_price := v_price * p_hours; end if;
  insert into public.reservations(profile_id,kind,starts_at,ends_at,gross_cents,created_by)
  values(v_target,p_kind,v_start,v_end,v_price,v_actor) returning id into v_id;
  return v_id;
exception when exclusion_violation then
  raise exception 'Dieser Zeitraum ist bereits belegt.' using errcode='23P01';
end;
$$;

create or replace function public.cancel_reservation(p_id uuid)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_row public.reservations%rowtype;
  v_admin boolean := (select private.is_admin());
begin
  if not (select private.is_active()) then raise exception 'Keine Berechtigung.' using errcode='42501'; end if;
  select * into v_row from public.reservations where id=p_id for update;
  if not found then raise exception 'Buchung nicht gefunden.' using errcode='22023'; end if;
  if not v_admin and (v_row.profile_id is distinct from (select auth.uid()))
    then raise exception 'Nur eigene Buchungen stornierbar.' using errcode='42501'; end if;
  if v_row.status <> 'confirmed' then raise exception 'Buchung bereits storniert.' using errcode='22023'; end if;
  if v_row.starts_at <= now() then
    raise exception 'Begonnene oder vergangene Buchungen dürfen nicht storniert werden.' using errcode='22023'; end if;
  update public.reservations set status='cancelled', cancelled_at=now() where id=p_id;
end;
$$;

create or replace function public.admin_block_day(p_day date, p_reason text default '')
returns uuid language plpgsql security definer set search_path = '' as $$
declare v_id uuid;
begin
  if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
  if p_day is null or p_day < (now() at time zone 'Europe/Berlin')::date
    or p_day > (now() at time zone 'Europe/Berlin')::date + 730
    then raise exception 'Datum ungültig.' using errcode='22023'; end if;
  if length(coalesce(p_reason,'')) > 160 then raise exception 'Grund zu lang.' using errcode='22023'; end if;
  insert into public.reservations(profile_id,kind,starts_at,ends_at,gross_cents,created_by,note)
  values(null,'block',(p_day + time '08:00') at time zone 'Europe/Berlin',
         (p_day + time '22:00') at time zone 'Europe/Berlin',0,(select auth.uid()),coalesce(p_reason,''))
  returning id into v_id;
  return v_id;
exception when exclusion_violation then
  raise exception 'Dieser Tag ist bereits ganz oder teilweise belegt.' using errcode='23P01';
end;
$$;

create or replace function public.admin_set_active(p_user_id uuid, p_active boolean)
returns void language plpgsql security definer set search_path = '' as $$
begin
  if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
  if p_user_id is null or p_active is null then raise exception 'Ungültige Anfrage.' using errcode='22023'; end if;
  update public.profiles set active=p_active where id=p_user_id and role='colleague';
  if not found then raise exception 'Kollegin nicht gefunden.' using errcode='22023'; end if;
end;
$$;

-- Returns only administrator's billing period (month of local START), no cancelled/booked blocks.
create or replace function public.admin_monthly_bookings(p_month date)
returns table (booking_id uuid, profile_id uuid, display_name text, email text,
  kind text, starts_at timestamptz, ends_at timestamptz, gross_cents integer)
language plpgsql stable security definer set search_path = '' as $$
declare v_month date;
begin
  if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
  if p_month is null or extract(day from p_month) <> 1 then
    raise exception 'Bitte den Monatsersten angeben.' using errcode='22023'; end if;
  v_month := p_month;
  return query
    select r.id, p.id, p.display_name, p.email, r.kind, r.starts_at, r.ends_at, r.gross_cents
    from public.reservations r join public.profiles p on p.id=r.profile_id
    where r.status='confirmed'
      and r.kind <> 'block'
      and r.starts_at >= (v_month::timestamp at time zone 'Europe/Berlin')
      and r.starts_at < ((v_month + interval '1 month') at time zone 'Europe/Berlin')
    order by p.display_name, r.starts_at;
end;
$$;

-- Harden default EXECUTE grants. Public API functions are tightly gated internally.
revoke execute on all functions in schema private from public, anon, authenticated;
revoke execute on function public.update_my_name(text) from public, anon;
revoke execute on function public.busy_slots(date,date) from public, anon;
revoke execute on function public.book_practice(text,date,time,integer,uuid) from public, anon;
revoke execute on function public.cancel_reservation(uuid) from public, anon;
revoke execute on function public.admin_block_day(date,text) from public, anon;
revoke execute on function public.admin_set_active(uuid,boolean) from public, anon;
revoke execute on function public.admin_monthly_bookings(date) from public, anon;
grant execute on function private.is_active(), private.is_admin() to authenticated;
grant execute on function public.update_my_name(text), public.busy_slots(date,date),
  public.book_practice(text,date,time,integer,uuid), public.cancel_reservation(uuid),
  public.admin_block_day(date,text), public.admin_set_active(uuid,boolean),
  public.admin_monthly_bookings(date) to authenticated;

-- Ensure future functions are NOT executable by PUBLIC by default, when created by postgres.
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema private revoke execute on functions from public;

-- Manually promote Vicky ONLY AFTER her OTP signup:
-- update public.profiles set role='admin', active=true
--   where id = (select id from auth.users where email = 'VICKYS-EMAIL@EXAMPLE.DE');
-- Verify exactly one row was updated; never promote using browser/user-supplied metadata.
