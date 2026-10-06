create extension if not exists pgcrypto;

create table if not exists public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  google_id text unique,
  username text not null,
  display_name text not null,
  email text,
  created_at timestamptz not null default now()
);

alter table public.users alter column google_id drop not null;
alter table public.users add column if not exists username text;

with profile_names as (
  select
    id,
    coalesce(nullif(trim(display_name), ''), 'Player') as base_name
  from public.users
  where username is null
), ranked_names as (
  select
    id,
    base_name,
    count(*) over (partition by lower(base_name)) as name_count
  from profile_names
)
update public.users as users
set username = case
  when ranked_names.name_count = 1 then ranked_names.base_name
  else ranked_names.base_name || '_' || left(replace(ranked_names.id::text, '-', ''), 8)
end
from ranked_names
where users.id = ranked_names.id;

alter table public.users alter column username set not null;
create unique index if not exists users_username_lower_unique_idx on public.users (lower(username));

create or replace function public.create_auth_user_profile()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  requested_username text := lower(trim(coalesce(new.raw_user_meta_data ->> 'username', '')));
  display_name text := coalesce(
    nullif(trim(new.raw_user_meta_data ->> 'display_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'full_name'), ''),
    nullif(trim(new.raw_user_meta_data ->> 'name'), ''),
    new.email,
    'Player'
  );
  provider text := coalesce(new.raw_app_meta_data ->> 'provider', 'email');
  google_username_base text;
begin
  if provider = 'google' and requested_username = '' then
    google_username_base := coalesce(nullif(trim(display_name), ''), 'Player');
    requested_username := google_username_base;
    insert into public.users (id, username, display_name, email)
    values (new.id, requested_username, display_name, new.email)
    on conflict (lower(username)) do nothing;
    if not found then
      requested_username := left(google_username_base, 60) || '_' || left(replace(new.id::text, '-', ''), 8);
      insert into public.users (id, username, display_name, email)
      values (new.id, requested_username, display_name, new.email);
    end if;
    return new;
  end if;

  if requested_username !~ '^[a-z0-9_]{3,24}$' then
    raise exception 'Username must be 3-24 characters using lowercase letters, numbers, or underscores.';
  end if;

  insert into public.users (id, username, display_name, email)
  values (new.id, requested_username, display_name, new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created_profile on auth.users;
create trigger on_auth_user_created_profile
  after insert on auth.users
  for each row execute procedure public.create_auth_user_profile();

create table if not exists public.games (
  id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  name text not null,
  download_url_pc text,
  download_url_android text
);

alter table public.games add column if not exists download_url_pc text;

create table if not exists public.purchases (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create table if not exists public.scores (
  user_id uuid not null references public.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  score numeric not null check (score >= 0),
  updated_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

create table if not exists public.session_login_codes (
  code_hash text primary key,
  user_id uuid not null references auth.users (id) on delete cascade,
  session_token text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists scores_leaderboard_idx on public.scores (game_id, score desc);
create index if not exists session_login_codes_expires_at_idx on public.session_login_codes (expires_at);

alter table public.users enable row level security;
alter table public.games enable row level security;
alter table public.purchases enable row level security;
alter table public.scores enable row level security;
alter table public.session_login_codes enable row level security;

insert into public.games (slug, name, download_url_pc, download_url_android)
values ('stare-at-a-guy-simulator', 'Stare at a Guy Simulator', null, null)
on conflict (slug) do nothing;