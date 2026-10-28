-- Hebammen Lounge: one-time additive migration AFTER supabase/schema.sql.
-- Run as postgres owner in SQL Editor; NOT via the public browser.
-- NO send is possible unless the operator fills issuer settings and enables delivery.

alter table public.profiles
  add column if not exists billing_name text not null default '',
  add column if not exists billing_street text not null default '',
  add column if not exists billing_postal_code text not null default '',
  add column if not exists billing_city text not null default '';

alter table public.profiles
  add constraint billing_fields_length check (
    char_length(billing_name) <= 160 and char_length(billing_street) <= 180 and
    char_length(billing_postal_code) <= 16 and char_length(billing_city) <= 100
  );

create or replace function public.update_my_billing(
 p_name text, p_street text, p_postal_code text, p_city text
) returns void language plpgsql security definer set search_path = '' as $$
begin
 if (select auth.uid()) is null then raise exception 'Bitte anmelden.' using errcode='42501'; end if;
 if length(btrim(coalesce(p_name,''))) not between 3 and 160
    or length(btrim(coalesce(p_street,''))) not between 4 and 180
    or length(btrim(coalesce(p_postal_code,''))) not between 3 and 16
    or length(btrim(coalesce(p_city,''))) not between 2 and 100
 then raise exception 'Bitte eine vollständige Rechnungsanschrift angeben.' using errcode='22023'; end if;
 update public.profiles set billing_name=btrim(p_name), billing_street=btrim(p_street),
   billing_postal_code=btrim(p_postal_code), billing_city=btrim(p_city)
 where id = (select auth.uid());
end;
$$;
revoke all on function public.update_my_billing(text,text,text,text) from public, anon;
grant execute on function public.update_my_billing(text,text,text,text) to authenticated;

-- SQL-only financial configuration; deliberately not exposed via the REST API.
create table if not exists private.invoice_settings (
 singleton boolean primary key default true check(singleton),
 issuer_name text not null default '',
 issuer_street text not null default '',
 issuer_postal_code text not null default '',
 issuer_city text not null default '',
 issuer_tax_number text not null default '',
 vat_mode text check(vat_mode in ('standard19','small_business','exempt')),
 tax_exemption_note text not null default '',
 iban text not null default '',
 payment_days integer not null default 14 check (payment_days between 0 and 120),
 delivery_enabled boolean not null default false,
 updated_at timestamptz not null default now()
);
insert into private.invoice_settings(singleton) values(true) on conflict do nothing;
revoke all on private.invoice_settings from public, anon, authenticated;

create sequence if not exists private.invoice_number_seq;
revoke all on sequence private.invoice_number_seq from public, anon, authenticated;

create table if not exists public.invoice_months (
 month date primary key check (extract(day from month)=1),
 closed_at timestamptz not null default now(),
 closed_by uuid not null references auth.users(id) on delete restrict
);
create table if not exists public.invoices (
 id uuid primary key default gen_random_uuid(),
 month date not null references public.invoice_months(month) on delete restrict,
 profile_id uuid not null references public.profiles(id) on delete restrict,
 invoice_number text not null unique,
 invoice_date date not null,
 recipient_email text not null,
 recipient_snapshot jsonb not null,
 issuer_snapshot jsonb not null,
 lines_snapshot jsonb not null,
 gross_cents integer not null check(gross_cents>0),
 net_cents integer not null check(net_cents>=0),
 vat_cents integer not null check(vat_cents>=0),
 vat_mode text not null check(vat_mode in ('standard19','small_business','exempt')),
 status text not null default 'pending' check(status in ('pending','sending','sent','failed','review')),
 pdf_path text,
 provider_email_id text,
 last_error text,
 attempted_at timestamptz,
 sent_at timestamptz,
 created_at timestamptz not null default now(),
 unique(month,profile_id),
 check(net_cents + vat_cents = gross_cents)
);
create index if not exists invoices_month_status on public.invoices(month,status);
alter table public.invoice_months enable row level security;
alter table public.invoices enable row level security;
revoke all on public.invoice_months, public.invoices from public, anon, authenticated;
grant select on public.invoice_months, public.invoices to authenticated;
create policy invoice_months_admin_read on public.invoice_months for select to authenticated
  using ((select private.is_admin()));
create policy invoices_admin_read on public.invoices for select to authenticated
  using ((select private.is_admin()));

-- Immutable historic snapshot, grouped by starting month (Europe/Berlin).
-- A month may only be closed AFTER the month ended. Advisory lock serializes concurrent closes.
create or replace function public.admin_prepare_month(p_month date)
returns integer language plpgsql security definer set search_path = '' as $$
declare
 s private.invoice_settings%rowtype;
 r record;
 v_lines jsonb;
 v_total integer;
 v_tax integer;
 v_count integer := 0;
 v_start timestamptz;
 v_end timestamptz;
begin
 if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
 if p_month is null or extract(day from p_month)<>1 or
    p_month >= date_trunc('month',now() at time zone 'Europe/Berlin')::date
 then raise exception 'Nur vollständig abgelaufene Monate dürfen abgeschlossen werden.' using errcode='22023'; end if;
 perform pg_advisory_xact_lock(hashtextextended('hebammen-invoice-'||p_month::text,0));
 if exists(select 1 from public.invoice_months where month=p_month) then
   select count(*) into v_count from public.invoices where month=p_month;
   return v_count; -- idempotent; never create a second invoice
 end if;
 select * into s from private.invoice_settings where singleton=true;
 if not found or not s.delivery_enabled or length(btrim(s.issuer_name))<3 or
    length(btrim(s.issuer_street))<4 or length(btrim(s.issuer_city))<2 or
    length(btrim(s.issuer_postal_code))<3 or length(btrim(s.issuer_tax_number))<3 or
    s.vat_mode is null or (s.vat_mode <> 'standard19' and length(btrim(s.tax_exemption_note))<5)
 then raise exception 'Rechnungsversand nicht freigegeben: Absender-, Steuerangaben und Freigabe im SQL-Setup prüfen.' using errcode='22023'; end if;
 v_start:=p_month::timestamp at time zone 'Europe/Berlin';
 v_end:=(p_month+interval '1 month') at time zone 'Europe/Berlin';
 -- Validate ALL billable people before modifying any record.
 if exists (
   select 1 from public.reservations b
   join public.profiles p on p.id=b.profile_id
   join auth.users u on u.id=p.id
   where b.status='confirmed' and b.kind<>'block'
   and b.starts_at>=v_start and b.starts_at<v_end
   and (length(btrim(p.billing_name))<3 or length(btrim(p.billing_street))<4
     or length(btrim(p.billing_postal_code))<3 or length(btrim(p.billing_city))<2
     or nullif(u.email,'') is null or u.email_confirmed_at is null)
 ) then raise exception 'Mindestens einer Kollegin fehlt eine bestätigte E-Mail oder vollständige Rechnungsanschrift.' using errcode='22023'; end if;
 insert into public.invoice_months(month,closed_by) values(p_month,(select auth.uid()));
 for r in
   select p.id profile_id, p.billing_name, p.billing_street, p.billing_postal_code,
          p.billing_city, u.email,
          sum(b.gross_cents)::integer total,
          jsonb_agg(jsonb_build_object('booking_id',b.id,'kind',b.kind,
             'starts_at',b.starts_at,'ends_at',b.ends_at,'gross_cents',b.gross_cents)
             order by b.starts_at,b.id) bookings
   from public.reservations b
   join public.profiles p on p.id=b.profile_id
   join auth.users u on u.id=p.id
   where b.status='confirmed' and b.kind<>'block'
    and b.starts_at>=v_start and b.starts_at<v_end
   group by p.id,p.billing_name,p.billing_street,p.billing_postal_code,p.billing_city,u.email
   order by p.id
 loop
  v_total:=r.total;
  v_tax:=case when s.vat_mode='standard19' then round(v_total*19.0/119.0)::integer else 0 end;
  insert into public.invoices(month,profile_id,invoice_number,invoice_date,
    recipient_email,recipient_snapshot,issuer_snapshot,lines_snapshot,
    gross_cents,net_cents,vat_cents,vat_mode)
  values (p_month,r.profile_id,
    'HL-'||extract(year from (now() at time zone 'Europe/Berlin'))::integer||'-'||
     lpad(nextval('private.invoice_number_seq')::text,6,'0'),
    (now() at time zone 'Europe/Berlin')::date,
    r.email,
    jsonb_build_object('name',r.billing_name,'street',r.billing_street,'postal',r.billing_postal_code,'city',r.billing_city),
    jsonb_build_object('name',s.issuer_name,'street',s.issuer_street,'postal',s.issuer_postal_code,
       'city',s.issuer_city,'tax_number',s.issuer_tax_number,'iban',s.iban,
       'payment_days',s.payment_days,'tax_exemption_note',s.tax_exemption_note),
    r.bookings,v_total,v_total-v_tax,v_tax,s.vat_mode);
  v_count:=v_count+1;
 end loop;
 return v_count;
end;
$$;

-- Admin-only invoice dispatch overview; no financial configuration is exposed.
create or replace function public.admin_month_invoices(p_month date)
returns table(id uuid,invoice_number text,recipient_email text,recipient_name text,
 gross_cents integer,status text,sent_at timestamptz,last_error text,pdf_path text)
language plpgsql stable security definer set search_path='' as $$
begin
 if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
 return query select i.id,i.invoice_number,i.recipient_email,
   i.recipient_snapshot->>'name',i.gross_cents,i.status,i.sent_at,i.last_error,i.pdf_path
   from public.invoices i where i.month=p_month order by i.invoice_number;
end;
$$;

-- Workers operate only with Supabase server-side service_role.
create or replace function public.worker_claim_invoice(p_month date)
returns uuid language plpgsql security definer set search_path='' as $$
declare v_id uuid;
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Nicht berechtigt.' using errcode='42501'; end if;
 with next as (
   select i.id from public.invoices i where i.month=p_month and i.status='pending'
   order by i.invoice_number limit 1 for update skip locked
 ) update public.invoices i set status='sending', attempted_at=now(),last_error=null
    from next where i.id=next.id returning i.id into v_id;
 return v_id;
end;
$$;
create or replace function public.worker_finish_invoice(
 p_id uuid,p_status text,p_pdf_path text default null,
 p_provider_id text default null,p_error text default null
) returns void language plpgsql security definer set search_path='' as $$
begin
 if (select auth.role()) <> 'service_role' then raise exception 'Nicht berechtigt.' using errcode='42501'; end if;
 if p_status not in ('sent','failed','review') then raise exception 'Status ungültig.' using errcode='22023'; end if;
 update public.invoices set status=p_status,
  pdf_path=coalesce(p_pdf_path,pdf_path),provider_email_id=left(p_provider_id,160),
  last_error=left(p_error,500), sent_at=case when p_status='sent' then now() else sent_at end
 where id=p_id and status='sending';
 if not found then raise exception 'Rechnung bereits in anderem Zustand.' using errcode='22023'; end if;
end;
$$;

-- Safe retry of a DEFINITIVELY REJECTED email only. Uncertain sends require manual reconciliation.
create or replace function public.admin_retry_failed_invoice(p_id uuid)
returns void language plpgsql security definer set search_path='' as $$
begin
 if not (select private.is_admin()) then raise exception 'Nur Admin.' using errcode='42501'; end if;
 update public.invoices set status='pending',last_error=null where id=p_id and status='failed';
 if not found then raise exception 'Nur endgültig fehlgeschlagene Rechnungen dürfen erneut eingeplant werden.' using errcode='22023'; end if;
end;
$$;

revoke execute on function public.admin_prepare_month(date) from public,anon;
revoke execute on function public.admin_month_invoices(date) from public,anon;
revoke execute on function public.admin_retry_failed_invoice(uuid) from public,anon;
grant execute on function public.admin_prepare_month(date),public.admin_month_invoices(date),
 public.admin_retry_failed_invoice(uuid) to authenticated;
revoke all on function public.worker_claim_invoice(date) from public,anon,authenticated;
revoke all on function public.worker_finish_invoice(uuid,text,text,text,text) from public,anon,authenticated;
grant execute on function public.worker_claim_invoice(date),
 public.worker_finish_invoice(uuid,text,text,text,text) to service_role;

-- Invoice PDF storage is PRIVATE. Admin access only; no anon access or public URLs.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('lounge-invoices','lounge-invoices',false,5242880,array['application/pdf'])
on conflict (id) do nothing;
create policy lounge_admin_pdf_read on storage.objects for select to authenticated
  using (bucket_id='lounge-invoices' and (select private.is_admin()));
-- The Edge Function writes with service_role, bypassing storage RLS.
