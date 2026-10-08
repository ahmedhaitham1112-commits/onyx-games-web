create extension if not exists pgcrypto;

create table if not exists public.device_links (
  device_code_hash text primary key,
  user_code text not null unique,
  user_id uuid references auth.users (id) on delete cascade,
  status text not null default 'pending' check (status in ('pending', 'approved', 'denied')),
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  redeemed_at timestamptz,
  check ((status = 'pending' and user_id is null) or (status <> 'pending' and user_id is not null))
);

create index if not exists device_links_expires_at_idx on public.device_links (expires_at);

create table if not exists public.game_sessions (
  user_id uuid not null references auth.users (id) on delete cascade,
  token_hash text primary key,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  last_used_at timestamptz
);

create index if not exists game_sessions_user_id_idx on public.game_sessions (user_id);
create index if not exists game_sessions_expires_at_idx on public.game_sessions (expires_at);

alter table public.device_links enable row level security;
alter table public.game_sessions enable row level security;

revoke all on public.device_links from anon, authenticated;
revoke all on public.game_sessions from anon, authenticated;
grant all on public.device_links to service_role;
grant all on public.game_sessions to service_role;

create or replace function public.poll_device_link(p_device_code_hash text)
returns table(status text, session_token text)
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  link_request public.device_links%rowtype;
  issued_token text;
  now_at timestamptz := now();
begin
  select * into link_request
  from public.device_links
  where device_code_hash = p_device_code_hash
  for update;

  if not found then
    return query select 'expired'::text, null::text;
    return;
  end if;

  if link_request.status = 'pending' then
    if link_request.expires_at <= now_at then
      return query select 'expired'::text, null::text;
    else
      return query select 'pending'::text, null::text;
    end if;
    return;
  end if;

  if link_request.status = 'denied' then
    return query select 'denied'::text, null::text;
    return;
  end if;

  if link_request.expires_at <= now_at or link_request.redeemed_at is not null then
    return query select 'expired'::text, null::text;
    return;
  end if;

  issued_token := encode(gen_random_bytes(32), 'hex');
  insert into public.game_sessions (user_id, token_hash, created_at, expires_at, last_used_at)
  values (
    link_request.user_id,
    encode(digest(issued_token, 'sha256'), 'hex'),
    now_at,
    now_at + interval '90 days',
    now_at
  );
  update public.device_links
  set redeemed_at = now_at
  where device_code_hash = p_device_code_hash;

  return query select 'approved'::text, issued_token;
end;
$$;

revoke all on function public.poll_device_link(text) from public, anon, authenticated;
grant execute on function public.poll_device_link(text) to service_role;
