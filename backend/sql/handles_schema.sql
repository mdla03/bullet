-- public.handles: one row per linked identity, the off-chain resolver's
-- handle -> user mapping. Written only by the handle_new_identity trigger
-- (see handles_github.sql); read by the resolver and the register/account UI.
--
-- APPLY ORDER for the three handles files, on a fresh project or an existing
-- one:
--   1. handles_schema.sql   (this file: table, constraints, indexes, RLS, trigger)
--   2. handles_github.sql   (the trigger function, plus the GitHub namespace
--                            data migration, which must run before step 3)
--   3. handles_unique.sql   (the unique index on handle_normalized; runs
--                            CONCURRENTLY, so submit it on its own)
--
-- On a FRESH project, run this file once more after step 2. The trigger block
-- at the bottom needs public.handle_new_identity() to exist, and step 2 is what
-- creates it; the first pass raises a warning and skips, the second pass wires
-- the trigger up. On the existing project every statement here is already a
-- no-op.
--
-- WHY THIS FILE EXISTS: the table, its unique constraint and the trigger were
-- all created directly in the Supabase console and lived nowhere else. Every
-- other object in backend/sql/ is reproducible from the repo; this one was not,
-- so a fresh project could not be rebuilt and nothing recorded the
-- `(provider, subject)` constraint that handles_github.sql's ON CONFLICT
-- depends on.
--
-- NOTE: RECONSTRUCTED, NOT DUMPED. Written 2026-09-09 from what is actually
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
--
-- Deliberately NOT `drop constraint if exists; add constraint`: the live
-- constraint's name was never recorded either (same reason as the trigger
-- below). If it is called something else, the DROP is a silent no-op and the
-- ADD builds a SECOND identical unique index over the same two columns. The
-- window between the two statements is worse: on the existing project the DROP
-- does land whenever the name happens to match, and until the ADD completes
-- there is nothing stopping two rows claiming the same (provider, subject).
-- Add one only when no unique constraint on exactly those columns exists,
-- whatever it is named, and no bare unique index over them exists either
-- (a `create unique index` with no backing constraint, which pg_constraint
-- alone would miss).
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    where c.conrelid = 'public.handles'::regclass
      and c.contype = 'u'
      and c.conkey @> array[
        (select attnum from pg_attribute
          where attrelid = c.conrelid and attname = 'provider'),
        (select attnum from pg_attribute
          where attrelid = c.conrelid and attname = 'subject')
      ]
      and array_length(c.conkey, 1) = 2
  ) and not exists (
    select 1
    from pg_index i
    where i.indrelid = 'public.handles'::regclass
      and i.indisunique
      and i.indnkeyatts = 2
      and (select attnum from pg_attribute
            where attrelid = i.indrelid and attname = 'provider') = any(i.indkey)
      and (select attnum from pg_attribute
            where attrelid = i.indrelid and attname = 'subject') = any(i.indkey)
  ) then
    alter table public.handles add constraint handles_provider_subject_key
      unique (provider, subject);
  end if;
end
$$;

-- store.ts resolves a payee with `.eq("handle_normalized", key)` on every send,
-- and store.ts/invite.ts list a user's handles by user_id.
-- Superseded by the UNIQUE index in handles_unique.sql, which serves the same
-- lookups. Kept so this file alone still leaves the resolver's hot path indexed.
create index if not exists handles_handle_normalized_idx on public.handles (handle_normalized);
create index if not exists handles_user_id_idx           on public.handles (user_id);

-- The live project's actual unique index on handle_normalized is named
-- handles_handle_normalized_key (confirmed by catalog on 2026-09-09), not the
-- plain handles_handle_normalized_idx above. It is created by
-- handles_unique.sql (CONCURRENTLY, so it must run as its own statement, not
-- from this file); this comment records its existence for anyone reading this
-- file as the schema reference.

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
--
-- to_regproc(), not `'public.handle_new_identity'::regproc`: the cast RAISES
-- when the function does not exist, which is exactly the state a fresh project
-- is in if this file is run before handles_github.sql. to_regproc() returns
-- null instead, so the block skips and the apply order at the top of this file
-- stays a preference rather than a hard requirement.
do $$
declare
  v_fn regproc := to_regproc('public.handle_new_identity');
begin
  if v_fn is null then
    raise warning 'public.handle_new_identity does not exist yet; apply handles_github.sql, then re-run this file to create the trigger';
  elsif not exists (
    select 1 from pg_trigger
    where not tgisinternal
      and tgfoid = v_fn
  ) then
    create trigger on_auth_identity_created
      after insert on auth.identities
      for each row execute function public.handle_new_identity();
  end if;
end
$$;
