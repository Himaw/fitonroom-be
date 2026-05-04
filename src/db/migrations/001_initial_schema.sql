create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  supabase_user_id text not null unique,
  email text,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);

create table if not exists device_profiles (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  install_id_hash text not null,
  platform text not null,
  app_version text,
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  unique (user_id, install_id_hash)
);

create table if not exists user_photos (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  device_profile_id uuid references device_profiles(id) on delete set null,
  s3_key text not null,
  image_type text not null default 'body_photo',
  content_type text not null,
  status text not null default 'pending_upload',
  created_at timestamptz not null default now()
);

create table if not exists product_inputs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  device_profile_id uuid references device_profiles(id) on delete set null,
  input_type text not null,
  source_url text,
  screenshot_s3_key text,
  extraction_status text not null default 'pending',
  created_at timestamptz not null default now()
);

create table if not exists try_on_jobs (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  device_profile_id uuid references device_profiles(id) on delete set null,
  user_photo_id uuid not null references user_photos(id) on delete restrict,
  product_input_id uuid not null references product_inputs(id) on delete restrict,
  status text not null default 'pending',
  fiton_cost integer not null default 1,
  failure_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists try_on_results (
  id uuid primary key default gen_random_uuid(),
  job_id uuid not null unique references try_on_jobs(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  result_s3_key text not null,
  thumbnail_s3_key text,
  provider text,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table if not exists fiton_accounts (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null unique references app_users(id) on delete cascade,
  available_balance integer not null default 0,
  updated_at timestamptz not null default now()
);

create table if not exists fiton_ledger_entries (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  entry_type text not null,
  amount integer not null,
  balance_after integer not null,
  source text not null,
  reference_id text,
  expires_at timestamptz,
  created_at timestamptz not null default now()
);

create unique index if not exists fiton_initial_trial_once
  on fiton_ledger_entries(user_id)
  where source = 'initial_trial';

create table if not exists subscription_plans (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  monthly_fitons integer not null,
  price_amount integer,
  currency text not null default 'usd',
  active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists user_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  plan_id uuid references subscription_plans(id) on delete set null,
  provider text not null,
  provider_subscription_id text,
  status text not null,
  current_period_start timestamptz,
  current_period_end timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists payment_customers (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  provider text not null,
  provider_customer_id text not null,
  created_at timestamptz not null default now(),
  unique(provider, provider_customer_id)
);

create table if not exists payment_events (
  id uuid primary key default gen_random_uuid(),
  provider text not null,
  provider_event_id text not null,
  event_type text not null,
  processed_at timestamptz not null default now(),
  unique(provider, provider_event_id)
);

create table if not exists push_tokens (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  device_profile_id uuid references device_profiles(id) on delete cascade,
  platform text not null,
  token text not null,
  enabled boolean not null default true,
  updated_at timestamptz not null default now(),
  unique(user_id, token)
);

create table if not exists deletion_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  status text not null default 'requested',
  requested_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists user_photos_user_id_idx on user_photos(user_id);
create index if not exists product_inputs_user_id_idx on product_inputs(user_id);
create index if not exists try_on_jobs_user_id_created_at_idx on try_on_jobs(user_id, created_at desc);
create index if not exists try_on_results_user_id_created_at_idx on try_on_results(user_id, created_at desc);
create index if not exists fiton_ledger_user_id_created_at_idx on fiton_ledger_entries(user_id, created_at desc);

insert into subscription_plans (name, monthly_fitons, price_amount, currency, active)
values
  ('Starter', 30, null, 'usd', true),
  ('Plus', 100, null, 'usd', true),
  ('Pro', 250, null, 'usd', true)
on conflict (name) do nothing;
