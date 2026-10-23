-- Add platform-wide rewards and download throttling without changing existing quest or ledger rows.
begin;

create table if not exists public.platform_reward_nodes (
  node_index integer primary key check (node_index > 0),
  quests_required integer not null unique check (quests_required > 0),
  shards bigint not null check (shards > 0),
  is_mystery boolean not null default false
);

create table if not exists public.platform_reward_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  node_index integer not null references public.platform_reward_nodes (node_index),
  claimed_at timestamptz not null default now(),
  primary key (user_id, node_index)
);

insert into public.platform_reward_nodes (node_index, quests_required, shards, is_mystery)
values
  (1, 2, 20, false),
  (2, 4, 20, false),
  (3, 6, 20, false),
  (4, 8, 20, false),
  (5, 10, 200, true)
on conflict (node_index) do update set
  quests_required = excluded.quests_required,
  shards = excluded.shards,
  is_mystery = excluded.is_mystery;

create table if not exists public.download_events (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  requested_at timestamptz not null default now(),
  allowed boolean not null,
  denial_reason text
);

create index if not exists platform_reward_claims_user_idx
  on public.platform_reward_claims (user_id, node_index);
create index if not exists download_events_user_requested_idx
  on public.download_events (user_id, requested_at desc);
create index if not exists download_events_user_game_allowed_idx
  on public.download_events (user_id, game_id)
  where allowed;

alter table public.platform_reward_nodes enable row level security;
alter table public.platform_reward_claims enable row level security;
alter table public.download_events enable row level security;

revoke all on public.platform_reward_nodes from public, anon, authenticated;
revoke all on public.platform_reward_claims from public, anon, authenticated;
revoke all on public.download_events from public, anon, authenticated;
grant all on public.platform_reward_nodes to service_role;
grant all on public.platform_reward_claims to service_role;
grant all on public.download_events to service_role;

create or replace function public.claim_platform_quest_reward(
  p_user_id uuid,
  p_node_index integer
)
returns table(claimed boolean, shards bigint, balance bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  reward public.platform_reward_nodes%rowtype;
  completed_count integer;
  inserted_count integer;
  ledger_id uuid;
  new_balance bigint;
begin
  select * into reward
  from public.platform_reward_nodes
  where node_index = p_node_index;

  if not found then
    raise exception 'Reward milestone not found.' using errcode = 'P0001';
  end if;

  select count(*)::integer into completed_count
  from public.quest_completions as completion
  where completion.user_id = p_user_id;

  if completed_count < reward.quests_required then
    raise exception 'Complete more quests before claiming this reward.' using errcode = 'P0001';
  end if;

  insert into public.platform_reward_claims (user_id, node_index)
  values (p_user_id, p_node_index)
  on conflict (user_id, node_index) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 0 then
    select coalesce(wallet.balance, 0) into new_balance
    from (select 1) as singleton
    left join public.shard_wallets as wallet on wallet.user_id = p_user_id;
    return query select false, 0::bigint, new_balance;
    return;
  end if;

  insert into public.shard_ledger (user_id, amount, reason, ref)
  values (p_user_id, reward.shards, 'platform_quest_reward', p_node_index::text)
  on conflict (user_id, reason, ref) do nothing
  returning id into ledger_id;

  if ledger_id is null then
    select coalesce(wallet.balance, 0) into new_balance
    from (select 1) as singleton
    left join public.shard_wallets as wallet on wallet.user_id = p_user_id;
    return query select false, 0::bigint, new_balance;
    return;
  end if;

  insert into public.shard_wallets as wallet (user_id, balance)
  values (p_user_id, reward.shards)
  on conflict (user_id) do update
    set balance = wallet.balance + excluded.balance
  returning wallet.balance into new_balance;

  return query select true, reward.shards, new_balance;
end;
$$;

revoke all on function public.claim_platform_quest_reward(uuid, integer)
  from public, anon, authenticated;
grant execute on function public.claim_platform_quest_reward(uuid, integer)
  to service_role;

create or replace function public.request_game_download(
  p_user_id uuid,
  p_game_id uuid
)
returns table(allowed boolean, message text, retry_after_seconds integer)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  now_at timestamptz := clock_timestamp();
  recent_count integer;
  daily_count integer;
  oldest_recent timestamptz;
  next_daily_reset timestamptz;
  wait_seconds integer := 0;
  denial text;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_user_id::text, 0));

  select count(*)::integer, max(download_event.requested_at)
  into recent_count, oldest_recent
  from public.download_events as download_event
  where download_event.user_id = p_user_id
    and download_event.allowed
    and download_event.requested_at > now_at - interval '60 seconds';

  select count(*)::integer
  into daily_count
  from public.download_events as download_event
  where download_event.user_id = p_user_id
    and download_event.allowed
    and download_event.requested_at >= (
      date_trunc('day', now_at at time zone 'UTC') at time zone 'UTC'
    );

  if recent_count > 0 then
    wait_seconds := greatest(
      1,
      ceil(extract(epoch from (oldest_recent + interval '60 seconds' - now_at)))::integer
    );
    denial := 'Please wait before requesting another download link.';
  end if;

  if daily_count >= 5 then
    next_daily_reset := (
      (date_trunc('day', now_at at time zone 'UTC') + interval '1 day') at time zone 'UTC'
    );
    wait_seconds := greatest(
      wait_seconds,
      ceil(extract(epoch from (next_daily_reset - now_at)))::integer
    );
    denial := 'You have reached the limit of 5 download links per day. Please try again tomorrow.';
  end if;

  insert into public.download_events (user_id, game_id, requested_at, allowed, denial_reason)
  values (p_user_id, p_game_id, now_at, denial is null, denial);

  if denial is not null then
    return query select false, denial, wait_seconds;
    return;
  end if;

  return query select true, 'Your download is ready.', 0;
end;
$$;

revoke all on function public.request_game_download(uuid, uuid)
  from public, anon, authenticated;
grant execute on function public.request_game_download(uuid, uuid)
  to service_role;

commit;
