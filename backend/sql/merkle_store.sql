-- Durable Merkle state (fixes the ephemeral-disk bug).
--
-- The deposit indexer used to persist the Merkle leaves + ledger cursor to
-- local JSON on disk. On an ephemeral host (Railway) a redeploy wiped that,
-- desyncing the tree and making already-deposited notes unclaimable. Move the
-- source of truth to Postgres: the indexer hydrates the in-memory tree from
-- these tables on boot and write-throughs every new leaf, so restarts/redeploys
-- can't lose the tree.
--
-- Apply in the Supabase SQL editor. Service-role only (the backend); RLS on
-- with no anon/authenticated policy = browsers can't read or write.

create table if not exists public.merkle_leaves (
  leaf_index  integer primary key,
  commitment  text not null unique,   -- decimal Fr string
  created_at  timestamptz not null default now()
);

create table if not exists public.merkle_state (
  id             boolean primary key default true,  -- single row
  cursor_ledger  bigint,
  updated_at     timestamptz not null default now(),
  constraint merkle_state_singleton check (id)
);

alter table public.merkle_leaves enable row level security;
alter table public.merkle_state  enable row level security;

-- No anon/authenticated policies => only the service role (backend) can touch
-- these. Revoke direct grants as belt-and-suspenders.
revoke all on public.merkle_leaves from anon, authenticated;
revoke all on public.merkle_state  from anon, authenticated;
