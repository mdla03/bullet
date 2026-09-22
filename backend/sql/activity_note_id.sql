-- Link a claim activity row back to the note it claimed, so the inbox can show
-- the explorer link for a claim made in an earlier session. Until now the tx
-- hash only lived in React state and vanished on reload.
--
-- Why here and not on `notes`: notes.SELECT is public (notes_rls.sql), so a tx
-- hash on that row would let any observer join a recipient's bullet_pubkey to
-- the on-chain address that claimed it. `activity` is service-role only and
-- filtered per user.
--
-- This does not create a cross-user link. Notes rows carry no sender identity
-- (POST /notes is unauthenticated by design), so a note_id on a receiver's
-- claim row reaches nothing the receiver does not already own. Send rows must
-- never carry it: the backend only sets it for type = 'claim'.
--
-- Apply in the Supabase SQL editor.

alter table public.activity
  add column if not exists note_id uuid references public.notes(id) on delete set null;
