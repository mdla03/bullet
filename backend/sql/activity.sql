-- User activity log (sends + claims). Each row is one user's own view of an
-- event they initiated. No cross-user links: a sender's "send" row and a
-- receiver's "claim" row share no foreign key, preserving ZK unlinkability.
--
-- Apply in the Supabase SQL editor. Service-role only; RLS on with no
-- anon/authenticated policy.

create table if not exists public.activity (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references public.profiles(id) on delete cascade,
  type        text not null check (type in ('send', 'claim')),
  amount      bigint not null,              -- stroops (1 USDC = 10_000_000)
  tx_hash     text,
  handle      text,                         -- recipient handle (sends only)
  created_at  timestamptz not null default now()
);

create index if not exists activity_user_created_idx
  on public.activity (user_id, created_at desc);

alter table public.activity enable row level security;

-- No anon/authenticated policies => only service role can read/write.
revoke all on public.activity from anon, authenticated;
