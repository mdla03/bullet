-- public.handles: one row per linked identity, the off-chain resolver's
-- handle -> user mapping. Written only by the handle_new_identity trigger
-- (see handles_github.sql); read by the resolver and the register/account UI.
--
-- WHY THIS FILE EXISTS: the table, its unique constraint and the trigger were
-- all created directly in the Supabase console and lived nowhere else. Every
-- other object in backend/sql/ is reproducible from the repo; this one was not,
-- so a fresh project could not be rebuilt and nothing recorded the
-- `(provider, subject)` constraint that handles_github.sql's ON CONFLICT
-- depends on.
--
-- ⚠ RECONSTRUCTED, NOT DUMPED. Written 2026-09-09 from what is actually
-- verifiable: the live column list (information_schema, 7 columns, types as
-- below), the ON CONFLICT target in handles_github.sql, and the columns the
-- backend selects (store.ts, invite.ts). Defaults, nullability, foreign keys,
-- index names, RLS policies and the trigger's name/timing were NOT read from
-- the live database and are the conventional choices, not confirmed fact.
--
-- Before trusting this file, replace it with the real DDL. In the SQL editor:
--
--   -- columns, types, nullability, defaults
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'handles'
--   order by ordinal_position;
--
--   -- constraints (PK / unique / FK) and indexes
--   select conname, pg_get_constraintdef(oid)
--   from pg_constraint where conrelid = 'public.handles'::regclass;
--   select indexname, indexdef from pg_indexes
--   where schemaname = 'public' and tablename = 'handles';
--
--   -- the trigger: real name, timing, target table
--   select tgname, tgrelid::regclass as on_table, tgenabled,
--          pg_get_triggerdef(oid)
--   from pg_trigger
--   where not tgisinternal and tgfoid = 'public.handle_new_identity'::regproc;
--
--   -- RLS policies
--   select polname, polcmd, pg_get_expr(polqual, polrelid) as using_expr
--   from pg_policy where polrelid = 'public.handles'::regclass;
--
-- Apply in the Supabase SQL editor. Every statement is guarded, so running it
-- against the existing project is a no-op rather than a redefinition.

create table if not exists public.handles (
  id                uuid primary key default gen_random_uuid(),
  user_id           uuid not null references auth.users(id) on delete cascade,
  provider          text not null,   -- raw auth.identities.provider value
  subject           text not null,   -- auth.identities.provider_id
  handle            text not null,   -- display form ("@alice", "alice@x.com")
  handle_normalized text not null,   -- canonical form the resolver keys on
  linked_at         timestamptz not null default now()
);

-- handles_github.sql's `on conflict (provider, subject) do update` REQUIRES
-- this. Without it the trigger raises instead of upserting, and re-linking an
-- identity fails.
alter table public.handles drop constraint if exists handles_provider_subject_key;
alter table public.handles add  constraint handles_provider_subject_key
  unique (provider, subject);

-- store.ts resolves a payee with `.eq("handle_normalized", key)` on every send,
-- and store.ts/invite.ts list a user's handles by user_id.
create index if not exists handles_handle_normalized_idx on public.handles (handle_normalized);
create index if not exists handles_user_id_idx           on public.handles (user_id);

-- Same model as notes/merkle_store: writes are service-role only. A browser
-- that could insert here could publish a key against someone else's handle and
-- redirect their payments, which is exactly the control-proof the OAuth flow
-- exists to establish. RLS on with no anon/authenticated policy denies both.
alter table public.handles enable row level security;
revoke all on public.handles from anon, authenticated;

-- The trigger itself. handles_github.sql only does CREATE OR REPLACE FUNCTION,
-- so on a fresh project that file defines the function and nothing ever fires
-- it.
--
-- Deliberately NOT `drop trigger if exists <name>; create trigger <name>`:
-- the live trigger's name was never recorded, and `on_auth_identity_created`
-- below is a guess. A wrong guess makes the DROP a no-op and the CREATE add a
-- SECOND trigger on the same function, so every identity insert runs
-- handle_new_identity twice. Instead, create one only when the function has no
-- trigger bound to it at all. On the existing project this is a no-op; on a
-- fresh one it wires the function up.
do $$
begin
  if not exists (
    select 1 from pg_trigger
    where not tgisinternal
      and tgfoid = 'public.handle_new_identity'::regproc
  ) then
    create trigger on_auth_identity_created
      after insert on auth.identities
      for each row execute function public.handle_new_identity();
  end if;
end
$$;
