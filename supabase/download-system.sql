alter table public.games
  add column if not exists download_url_pc text;

create table if not exists public.purchases (
  user_id uuid not null references auth.users (id) on delete cascade,
  game_id uuid not null references public.games (id) on delete cascade,
  acquired_at timestamptz not null default now(),
  primary key (user_id, game_id)
);

alter table public.purchases enable row level security;

update public.games
set download_url_pc = 'https://your-host/your-windows-build.zip'
where slug = 'stare-at-a-guy-simulator';