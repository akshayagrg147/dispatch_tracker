-- Dispatch Register — AWS PostgreSQL schema
-- Run this once against the PostgreSQL database used by the API server.
-- The database must not be exposed directly to the browser. The Node API
-- is the only component that should have DATABASE_URL.

create extension if not exists pgcrypto;

create table if not exists users (
  id            uuid primary key default gen_random_uuid(),
  email         text not null unique,
  password_hash text not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now()
);

create table if not exists profiles (
  id         uuid primary key references users (id) on delete cascade,
  full_name  text not null default '',
  role       text not null default 'staff' check (role in ('admin', 'staff')),
  active     boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id             uuid primary key default gen_random_uuid(),
  order_date     date,
  inv_no         text not null,
  inv_date       date,
  party          text not null,
  pincode        text not null default '' check (pincode = '' or pincode ~ '^[0-9]{6}$'),
  area           text not null default '',
  state_name     text not null default '',
  contact        text not null default '',
  gstin          text not null default '',
  telecaller     text not null default '',
  transport      text not null default '',
  docket         text not null default '',
  dispatch_date  date,
  cases          integer not null default 0 check (cases >= 0),
  weight         numeric(10,2) check (weight is null or weight >= 0),
  freight        numeric(12,2) check (freight is null or freight >= 0),
  freight_mode   text not null default 'Paid' check (freight_mode in ('Paid', 'Credit', 'COD')),
  amount         numeric(14,2) not null default 0 check (amount >= 0),
  payment_status text not null default 'Credit' check (payment_status in ('Received', 'COD', 'Credit', 'Pending')),
  status         text not null default 'Dispatched' check (status in ('Dispatched', 'In Transit', 'Delivered', 'Returned')),
  delivery_date  date,
  remarks        text not null default '',
  tracking_slug  text not null default '',
  tracking_state text not null default '',
  tracking_note  text not null default '',
  tracking_checked_at timestamptz,
  status_source  text not null default 'manual' check (status_source in ('manual', 'auto')),
  created_by     uuid references users (id) on delete set null,
  updated_by     uuid references users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index if not exists orders_inv_no_uniq on orders (lower(inv_no));
create index if not exists orders_dispatch_date_idx on orders (dispatch_date desc);
create index if not exists orders_order_date_idx on orders (order_date desc);
create index if not exists orders_party_idx on orders (party);
create index if not exists orders_freight_mode_idx on orders (freight_mode);
create index if not exists orders_payment_status_idx on orders (payment_status);
create index if not exists orders_telecaller_idx on orders (telecaller);

create table if not exists telecallers (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  created_at timestamptz not null default now()
);
create unique index if not exists telecallers_name_uniq on telecallers (lower(name));

create table if not exists couriers (
  id             uuid primary key default gen_random_uuid(),
  transport_name text not null,
  slug           text not null default '',
  trackable      boolean not null default true,
  track_url      text not null default '',
  created_at     timestamptz not null default now()
);
create unique index if not exists couriers_name_uniq on couriers (lower(transport_name));

create or replace function set_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists orders_updated_at on orders;
create trigger orders_updated_at before update on orders
for each row execute function set_updated_at();

insert into couriers (transport_name, slug, trackable, track_url) values
  ('DTDC Courier',        'dtdc',      true,  'https://www.dtdc.com/track-your-shipment/'),
  ('DTDC (By Air)',       'dtdc',      true,  'https://www.dtdc.com/track-your-shipment/'),
  ('Delhivery',           'delhivery', true,  'https://www.delhivery.com/tracking'),
  ('Trackon',             'trackon',   true,  'https://www.trackon.in/home/track'),
  ('Blue Dart',           'blue-dart', true,  'https://www.bluedart.com/tracking'),
  ('VRL Logistics',       '',          true,  ''),
  ('SIS Logistics',       '',           false, ''),
  ('Nagpur Carrier',      '',           false, ''),
  ('Shri Azad Transport', '',           false, ''),
  ('Dalmia Cargo',        '',           false, '')
on conflict do nothing;
