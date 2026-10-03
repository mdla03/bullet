-- Dashboard metrics in one round trip, aggregated in Postgres.
--
-- The page used to pull rows and count them in JS: 5000 activity rows, 10000
-- wallets and 50000 more activity rows on every load. That is a lot of bytes
-- to move in order to produce about twenty integers, and the 5000 cap silently
-- made "transactions", "volume" and "active accounts" mean "within the most
-- recent 5000 rows" rather than what their labels say. This function counts
-- over the whole table, so those figures are now what they claim to be.
--
-- Returns one jsonb object. Values stay raw (stroops, provider strings,
-- canonical handles): mapping providers and handles to the handle-type
-- registry is the frontend's job, since the registry lives in TypeScript and
-- duplicating its resolution order here is exactly how the two would drift.
--
-- Apply in the Supabase SQL editor. Service-role only, like the tables it
-- reads. Safe to re-run.

create or replace function public.dashboard_metrics(
  days integer default 14,
  mau_days integer default 30
)
returns jsonb
language sql
stable
as $$
with totals as (
  select
    count(*)                                          as transactions,
    count(*) filter (where type = 'send')             as sends,
    count(*) filter (where type = 'claim')            as claims,
    count(distinct user_id)                           as active_accounts
  from public.activity
),
volume as (
  select jsonb_object_agg(token_id::text, total) as v
  from (
    select token_id, sum(amount) as total
    from public.activity
    group by token_id
  ) t
),
-- UTC days, matching how the chart labels them. A date_trunc in the session's
-- timezone would shift every bucket for a non-UTC connection.
daily as (
  select jsonb_agg(
           jsonb_build_object('date', d::text, 'sends', s, 'claims', c)
           order by d
         ) as rows
  from (
    select
      ((now() at time zone 'utc')::date - (days - 1 - i))                as d,
      count(a.id) filter (where a.type = 'send')                        as s,
      count(a.id) filter (where a.type = 'claim')                       as c
    from generate_series(0, days - 1) i
    left join public.activity a
      on (a.created_at at time zone 'utc')::date
         = ((now() at time zone 'utc')::date - (days - 1 - i))
    group by i
  ) x
),
-- Active = sent or claimed in the window. Rolling rather than calendar, so the
-- number does not reset to near-zero just after midnight UTC.
active as (
  select
    count(distinct user_id) filter (where created_at >= now() - interval '1 day') as dau,
    count(distinct user_id)                                                       as mau
  from public.activity
  where created_at >= now() - (mau_days || ' days')::interval
),
-- Every distinct address the project has seen, current or since replaced.
-- `previous` keeps the wallets an account switched away from, and notes
-- addressed to an old bullet_pubkey stay claimable only by reconnecting that
-- wallet, so those addresses are still real (backend/sql/wallet_previous.sql).
wallet_addresses as (
  select stellar_address as addr from public.wallets where stellar_address is not null
  union
  select p ->> 'stellar_address'
  from public.wallets w, jsonb_array_elements(w.previous) p
  where p ->> 'stellar_address' is not null
),
wallets_agg as (
  select
    (select count(*) from public.wallets where stellar_address is not null) as attached,
    (select count(*) from wallet_addresses)                                as unique_addresses
),
handles_agg as (
  select jsonb_object_agg(provider, n) as h
  from (select provider, count(*) as n from public.handles group by provider) t
),
-- Grouped by handle, not returned per row: distinct recipients are far fewer
-- than sends, and the frontend needs the canonical string to resolve its type.
sends_by_handle as (
  select jsonb_object_agg(handle, n) as s
  from (
    select handle, count(*) as n
    from public.activity
    where type = 'send' and handle is not null
    group by handle
  ) t
),
recent as (
  select jsonb_agg(to_jsonb(r)) as rows
  from (
    -- Rendered as UTC explicitly. A bare timestamptz serialises in the
    -- session's timezone, and the column this feeds is labelled "Time (UTC)".
    select type, amount, token_id, tx_hash,
           to_char(created_at at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as created_at
    from public.activity
    where tx_hash is not null
    order by created_at desc
    limit 15
  ) r
)
select jsonb_build_object(
  'deposits',        (select count(*) from public.merkle_leaves),
  'cursor_ledger',   (select cursor_ledger from public.merkle_state where id),
  'users',           (select count(*) from public.profiles),
  'unclaimed_notes', (select count(*) from public.notes where claimed_at is null),
  'pending_invites', (select count(*) from public.pending_invites),
  'transactions',    t.transactions,
  'sends',           t.sends,
  'claims',          t.claims,
  'active_accounts', t.active_accounts,
  'volume',          coalesce(v.v, '{}'::jsonb),
  'daily',           coalesce(d.rows, '[]'::jsonb),
  'dau',             ac.dau,
  'mau',             ac.mau,
  'wallets_attached', wa.attached,
  'wallets_unique',   wa.unique_addresses,
  'handles',          coalesce(h.h, '{}'::jsonb),
  'sends_by_handle',  coalesce(sh.s, '{}'::jsonb),
  'recent',           coalesce(rc.rows, '[]'::jsonb)
)
from totals t, volume v, daily d, active ac, wallets_agg wa,
     handles_agg h, sends_by_handle sh, recent rc;
$$;

revoke all on function public.dashboard_metrics(integer, integer) from anon, authenticated;
