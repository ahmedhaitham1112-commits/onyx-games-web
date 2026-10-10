create extension if not exists pgcrypto;

alter table public.device_links
  add column if not exists session_token text;

do $$
declare
  pgcrypto_schema text;
begin
  select namespace.nspname into pgcrypto_schema
  from pg_extension as extension
  join pg_namespace as namespace on namespace.oid = extension.extnamespace
  where extension.extname = 'pgcrypto';

  if pgcrypto_schema is null then
    raise exception 'pgcrypto extension is not installed';
  end if;

  execute format(
    'alter function public.poll_device_link(text) set search_path = public, %I, pg_temp',
    pgcrypto_schema
  );
end;
$$;