create extension if not exists pgcrypto;

do $$
begin
  if not exists (
    select 1 from public.games where slug = 'stare-at-a-guy-simulator'
  ) then
    raise exception 'Seed stare-at-a-guy-simulator in public.games before applying quests.sql';
  end if;
end;
$$;

alter table public.device_links
  add column if not exists game_id uuid references public.games (id) on delete cascade;
alter table public.device_links
  add column if not exists newly_completed_quests jsonb;

update public.device_links
set game_id = (select id from public.games where slug = 'stare-at-a-guy-simulator')
where game_id is null;

alter table public.device_links
  alter column game_id set not null;

create table if not exists public.quests (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  position integer not null check (position > 0),
  title text not null,
  description text not null,
  metric text not null check (metric in ('game_signin', 'score')),
  target numeric not null check (target > 0),
  unique (game_id, position)
);

create table if not exists public.quest_completions (
  user_id uuid not null references auth.users (id) on delete cascade,
  quest_id uuid not null references public.quests (id) on delete cascade,
  completed_at timestamptz not null default now(),
  primary key (user_id, quest_id)
);

create table if not exists public.reward_nodes (
  game_id uuid not null references public.games (id) on delete cascade,
  node_index integer not null check (node_index > 0),
  quests_required integer not null check (quests_required > 0),
  shards bigint not null check (shards > 0),
  is_mystery boolean not null default false,
  primary key (game_id, node_index)
);

create table if not exists public.shard_wallets (
  user_id uuid primary key references auth.users (id) on delete cascade,
  balance bigint not null default 0 check (balance >= 0)
);

create table if not exists public.shard_ledger (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users (id) on delete cascade,
  amount bigint not null,
  reason text not null,
  ref text not null,
  created_at timestamptz not null default now(),
  unique (user_id, reason, ref)
);

create table if not exists public.reward_claims (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null,
  node_index integer not null,
  claimed_at timestamptz not null default now(),
  primary key (user_id, game_id, node_index),
  foreign key (game_id, node_index)
    references public.reward_nodes (game_id, node_index) on delete cascade
);

create index if not exists quest_completions_quest_id_idx on public.quest_completions (quest_id);
create index if not exists reward_nodes_game_required_idx on public.reward_nodes (game_id, quests_required);
create index if not exists shard_ledger_user_created_idx on public.shard_ledger (user_id, created_at desc);

alter table public.quests enable row level security;
alter table public.quest_completions enable row level security;
alter table public.reward_nodes enable row level security;
alter table public.shard_wallets enable row level security;
alter table public.shard_ledger enable row level security;
alter table public.reward_claims enable row level security;

revoke all on public.quests from anon, authenticated;
revoke all on public.quest_completions from anon, authenticated;
revoke all on public.reward_nodes from anon, authenticated;
revoke all on public.shard_wallets from anon, authenticated;
revoke all on public.shard_ledger from anon, authenticated;
revoke all on public.reward_claims from anon, authenticated;

grant all on public.quests to service_role;
grant all on public.quest_completions to service_role;
grant all on public.reward_nodes to service_role;
grant all on public.shard_wallets to service_role;
grant all on public.shard_ledger to service_role;
grant all on public.reward_claims to service_role;

create or replace function public.approve_device_link(p_user_code text, p_user_id uuid)
returns table(game_id uuid, newly_completed_quests jsonb)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  link_request public.device_links%rowtype;
  completion_payload jsonb;
begin
  select * into link_request
  from public.device_links
  where user_code = p_user_code
    and status = 'pending'
    and expires_at > now()
  for update;

  if not found then
    return;
  end if;

  with eligible as (
    select quest.id, quest.title, quest.position
    from public.quests as quest
    where quest.game_id = link_request.game_id
      and (
        quest.metric = 'game_signin'
        or (
          quest.metric = 'score'
          and exists (
            select 1 from public.scores as score
            where score.user_id = p_user_id
              and score.game_id = quest.game_id
              and score.score >= quest.target
          )
        )
      )
  ), inserted as (
    insert into public.quest_completions (user_id, quest_id)
    select p_user_id, eligible.id from eligible
    on conflict (user_id, quest_id) do nothing
    returning quest_id
  )
  select coalesce(
    jsonb_agg(jsonb_build_object('id', quest.id, 'title', quest.title, 'position', quest.position) order by quest.position),
    '[]'::jsonb
  ) into completion_payload
  from inserted
  join public.quests as quest on quest.id = inserted.quest_id;

  update public.device_links
  set status = 'approved',
      user_id = p_user_id,
      newly_completed_quests = completion_payload
  where device_code_hash = link_request.device_code_hash;

  return query select link_request.game_id, completion_payload;
end;
$$;

revoke all on function public.approve_device_link(text, uuid) from public, anon, authenticated;
grant execute on function public.approve_device_link(text, uuid) to service_role;

create or replace function public.claim_quest_reward(
  p_user_id uuid,
  p_game_id uuid,
  p_node_index integer
)
returns table(claimed boolean, shards bigint, balance bigint)
language plpgsql
security definer
set search_path = pg_catalog, public, pg_temp
as $$
declare
  reward public.reward_nodes%rowtype;
  completed_count integer;
  inserted_count integer;
  new_balance bigint;
begin
  select * into reward
  from public.reward_nodes
  where game_id = p_game_id and node_index = p_node_index;

  if not found then
    raise exception 'Reward node not found.' using errcode = 'P0001';
  end if;

  select count(*)::integer into completed_count
  from public.quest_completions as completion
  join public.quests as quest on quest.id = completion.quest_id
  where completion.user_id = p_user_id and quest.game_id = p_game_id;

  if completed_count < reward.quests_required then
    raise exception 'Complete more quests before claiming this reward.' using errcode = 'P0001';
  end if;

  insert into public.reward_claims (user_id, game_id, node_index)
  values (p_user_id, p_game_id, p_node_index)
  on conflict (user_id, game_id, node_index) do nothing;
  get diagnostics inserted_count = row_count;

  if inserted_count = 0 then
    select coalesce(wallet.balance, 0) into new_balance
    from (select 1) as singleton
    left join public.shard_wallets as wallet on wallet.user_id = p_user_id;
    return query select false, 0::bigint, new_balance;
    return;
  end if;

  insert into public.shard_ledger (user_id, amount, reason, ref)
  values (p_user_id, reward.shards, 'quest_reward', p_game_id::text || ':' || p_node_index::text);

  insert into public.shard_wallets as wallet (user_id, balance)
  values (p_user_id, reward.shards)
  on conflict (user_id) do update
    set balance = wallet.balance + excluded.balance
  returning wallet.balance into new_balance;

  return query select true, reward.shards, new_balance;
end;
$$;

revoke all on function public.claim_quest_reward(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.claim_quest_reward(uuid, uuid, integer) to service_role;

insert into public.quests (game_id, position, title, description, metric, target)
select game.id, seed.position, seed.title, seed.description, seed.metric, seed.target
from public.games as game
cross join (values
  (1, 'Sign in to Stare at a Guy Simulator', 'Link your game account. The staring contest begins now.', 'game_signin', 1::numeric),
  (2, 'Reach 100 points', 'Hold your nerve and hit the century mark.', 'score', 100::numeric),
  (3, 'Reach 250 points', 'Become the final boss of unblinking eye contact.', 'score', 250::numeric)
) as seed(position, title, description, metric, target)
where game.slug = 'stare-at-a-guy-simulator'
on conflict (game_id, position) do update set
  title = excluded.title,
  description = excluded.description,
  metric = excluded.metric,
  target = excluded.target;

insert into public.reward_nodes (game_id, node_index, quests_required, shards, is_mystery)
select game.id, seed.node_index, seed.quests_required, seed.shards, seed.is_mystery
from public.games as game
cross join (values
  (1, 2, 20::bigint, true),
  (2, 3, 100::bigint, true)
) as seed(node_index, quests_required, shards, is_mystery)
where game.slug = 'stare-at-a-guy-simulator'
on conflict (game_id, node_index) do update set
  quests_required = excluded.quests_required,
  shards = excluded.shards,
  is_mystery = excluded.is_mystery;
