-- Wallet switching: keep every wallet an account has ever linked.
--
-- Bullet keys are derived from the wallet's signature over KEY_DOMAIN_MESSAGE,
-- so switching wallets changes bullet_pubkey. Notes are addressed to the
-- pubkey and the claim proof binds it, so notes sent to the old key can ONLY
-- be claimed by reconnecting the old wallet. Overwriting the row used to erase
-- any record that the old key existed, which made those notes unfindable.
--
-- `previous` holds [{stellar_address, bullet_pubkey, unlinked_at}, …], oldest
-- first. Read paths (unread count, mark-claimed, note delivery) match against
-- current + previous keys.
--
-- Apply in the Supabase SQL editor BEFORE deploying the backend that writes it.
-- Safe to re-run.

alter table public.wallets
  add column if not exists previous jsonb not null default '[]'::jsonb;

-- Note delivery looks up a pubkey inside `previous` (containment query).
create index if not exists wallets_previous_gin
  on public.wallets using gin (previous jsonb_path_ops);
