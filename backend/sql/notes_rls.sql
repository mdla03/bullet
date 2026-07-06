-- M4: lock down the `notes` table so browsers cannot spam arbitrary inboxes.
--
-- Model: notes are PUBLIC ciphertext (a sender seals a claim payload to the
-- recipient's Bullet pubkey). Reads can stay open; the payload is encrypted.
-- But WRITES must not be open to the anon/browser client, or anyone can insert
-- junk/phishing notes for any recipient_pubkey. All writes now go through the
-- backend service role (POST /notes validates + rate-limits; mark-claimed and
-- invite delivery already use the service role).
--
-- Apply in the Supabase SQL editor (or as a migration). Idempotent-ish; drop
-- existing permissive policies first if you had any.

alter table public.notes enable row level security;

-- Reads: allow (ciphertext is safe to expose; the inbox filters by pubkey).
drop policy if exists notes_select_public on public.notes;
create policy notes_select_public
  on public.notes
  for select
  using (true);

-- Writes: NO anon/authenticated policy. With RLS enabled and no INSERT/UPDATE/
-- DELETE policy for the anon or authenticated roles, those roles cannot write.
-- The service role bypasses RLS, so the backend keeps full write access.
drop policy if exists notes_insert_anon on public.notes;
drop policy if exists notes_update_anon on public.notes;
drop policy if exists notes_delete_anon on public.notes;

-- Optional hardening: revoke direct table grants from the browser roles so even
-- a future stray policy can't re-open writes.
revoke insert, update, delete on public.notes from anon, authenticated;
