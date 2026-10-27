-- Paas database setup
-- Run this once in Supabase: SQL Editor > New query > paste everything > Run.
-- It is safe to run again; it skips things that already exist.

-- A space is one shared pad. Every device linked to it sees the same text and files.
create table if not exists public.spaces (
  id                 uuid primary key default gen_random_uuid(),
  channel_key        text not null unique,          -- secret name of the live-sync channel
  content            text not null default '',
  allow_network_join boolean not null default true,  -- devices on the same WiFi can join without a code
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- Each browser that joins a space gets a device row. We only store a hash of its token.
create table if not exists public.devices (
  id           uuid primary key default gen_random_uuid(),
  space_id     uuid not null references public.spaces(id) on delete cascade,
  token_hash   text not null unique,
  name         text not null default 'Device',
  last_network text,                                 -- IPv4 address or IPv6 /64 prefix
  created_at   timestamptz not null default now(),
  last_seen    timestamptz not null default now()
);
create index if not exists devices_space_idx   on public.devices (space_id);
create index if not exists devices_network_idx on public.devices (last_network, last_seen desc);

-- Short one-time codes for linking a device on another network.
create table if not exists public.pair_codes (
  code       text primary key,
  space_id   uuid not null references public.spaces(id) on delete cascade,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);
create index if not exists pair_codes_space_idx on public.pair_codes (space_id);

-- Wrong code attempts, used to stop people guessing codes.
create table if not exists public.pair_attempts (
  id         bigint generated always as identity primary key,
  network    text not null,
  created_at timestamptz not null default now()
);
create index if not exists pair_attempts_network_idx on public.pair_attempts (network, created_at desc);

-- Uploaded files. The bytes live in Supabase Storage; this table lists them.
create table if not exists public.files (
  id         uuid primary key default gen_random_uuid(),
  space_id   uuid not null references public.spaces(id) on delete cascade,
  name       text not null,
  path       text not null unique,
  size       bigint not null default 0,
  mime       text,
  created_at timestamptz not null default now()
);
create index if not exists files_space_idx on public.files (space_id, created_at desc);

-- Lock every table. With RLS on and no policies, the public (anon) key can read nothing.
-- Only our API routes, which use the secret service role key, can touch the data.
alter table public.spaces        enable row level security;
alter table public.devices       enable row level security;
alter table public.pair_codes    enable row level security;
alter table public.pair_attempts enable row level security;
alter table public.files         enable row level security;

-- Private storage bucket for uploads, 25 MB per file.
insert into storage.buckets (id, name, public, file_size_limit)
values ('files', 'files', false, 26214400)
on conflict (id) do nothing;

-- Daily cleanup, called by /api/cron. Returns storage paths of files whose
-- space was deleted, so the cron job can remove those files from storage too.
create or replace function public.paas_cleanup()
returns setof text
language plpgsql
security definer
set search_path = public
as $$
begin
  delete from pair_codes    where expires_at < now();
  delete from pair_attempts where created_at < now() - interval '1 day';
  delete from devices       where last_seen  < now() - interval '90 days';

  return query
    with gone as (
      delete from spaces s
      where not exists (select 1 from devices d where d.space_id = s.id)
        and s.created_at < now() - interval '1 day'
      returning s.id
    )
    select f.path from files f join gone g on f.space_id = g.id;
end;
$$;

revoke all on function public.paas_cleanup() from public, anon, authenticated;
