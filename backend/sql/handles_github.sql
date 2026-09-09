-- Adds GitHub to the trigger that turns a linked Supabase identity into a
-- handles row, and namespaces the GitHub canonical form.
--
-- APPLY ORDER: handles_schema.sql, then THIS FILE, then handles_unique.sql.
-- The data migration at the top of this file has to run before the unique index
-- is created, or a pre-existing bare "alice" GitHub row and a future "alice"
-- from another bare-name provider would already be a duplicate.
--
-- WHY THE NAMESPACE. public.handles keys the resolver on one handle_normalized
-- column. The GitHub canonical form used to be the bare lowercase login, which
-- collides with any other bare-name provider (a Discord or Telegram "alice"
-- resolves to the same string as a GitHub "alice", and whichever row the
-- resolver happened to pick would take the other person's payments). The
-- canonical form is now 'github:' || lower(login), matching parseGithub in
-- shared/src/handles.ts. Display strips the prefix back off (format() there);
-- the UI shows the bare login next to the GitHub icon.
--
-- ── one-time data migration ──────────────────────────────────────────────────
-- Existing rows were written with the bare login. Idempotent: the NOT LIKE
-- makes a second run a no-op, and no other provider is touched.
update public.handles
   set handle            = 'github:' || handle,
       handle_normalized = 'github:' || handle_normalized
 where provider = 'github'
   and handle_normalized not like 'github:%';

-- ── the trigger function ─────────────────────────────────────────────────────
--
-- Mirrors the deployed function. The github branch and the delete-then-insert
-- below are the changes.
--
-- REVISION 2026-09-09b IS APPLIED. It shipped as migration
-- handles_github_scoped_eviction on 2026-09-09: the newest-wins delete below
-- gained `and user_id <> new.user_id` and its `raise notice` on eviction.
-- Confirmed against the live catalog:
--
--   select position('user_id <> new.user_id' in p.prosrc) > 0 as has_self_guard
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'handle_new_identity';
--   -> true
--
-- The paragraph below records the state of the PREVIOUS revision. Both the
-- github branch and the self-eviction guard are live now.
--
-- Applied to the project on 2026-09-08. CONFIRMED APPLIED 2026-09-09 by
-- introspecting the live catalog:
--
--   select position('github' in p.prosrc) > 0 as has_github_branch
--   from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--   where n.nspname = 'public' and p.proname = 'handle_new_identity';
--   -> true
--
-- Read the commit that introduced this file with that in mind: its subject
-- says "sql recorded, not yet applied", which was true when written and is
-- not true now. The catalog is the authority, not the commit message.
--
-- PROVEN END TO END 2026-09-09 by a real GitHub sign-in against the live
-- project. Before this, no GitHub identity had ever existed, so the branch had
-- never actually run. Resulting row:
--
--   provider | handle | handle_normalized | subject   | linked_at
--   github   | mdla03 | mdla03            | 119711499 | 2026-09-08 19:08:19+00
--
-- (That row predates the namespace; the migration above rewrites it to
-- github:mdla03.)
--
-- That single row closes three separate unknowns at once: the provider is
-- configured in Supabase Auth, the trigger fires on the github branch, and
-- identity_data really does carry user_name/preferred_username. The last one
-- was the risk worth testing: if it carried neither, v_handle would be null,
-- the guard below would return early, and NO handle row would be created with
-- no error raised anywhere. Silent. That silence is why the guard now raises a
-- warning. Re-test this way, not by reading the function, after any change to
-- the branch.
--
-- `subject` is GitHub's numeric user id, not the login, so the
-- `on conflict (provider, subject)` upsert survives a username change.
-- Table/trigger DDL: see handles_schema.sql.
create or replace function public.handle_new_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_handle text;
  v_evicted uuid;
begin
  if new.provider in ('twitter', 'twitter_v2', 'x') then
    -- X OAuth 2.0 puts the handle in preferred_username; OAuth 1.0a in user_name.
    v_handle := '@' || lower(coalesce(new.identity_data->>'user_name',
                                      new.identity_data->>'preferred_username'));
  elsif new.provider in ('google', 'email') then
    v_handle := lower(new.identity_data->>'email');
  elsif new.provider = 'github' then
    -- Supabase's GitHub provider sets user_name and preferred_username to the login.
    -- Namespaced so a bare login cannot collide with another provider's.
    v_handle := 'github:' || lower(coalesce(new.identity_data->>'user_name',
                                            new.identity_data->>'preferred_username'));
  else
    return new;
  end if;

  if v_handle is null or v_handle = '@' or v_handle = '' then
    -- Used to return silently, which is how a provider that stops sending the
    -- field would look exactly like a provider that was never configured.
    raise warning 'handle_new_identity: % identity % had no usable handle field',
      new.provider, new.provider_id;
    return new;
  end if;

  -- Charset guard, mirroring parseGithub in shared/src/handles.ts. A login the
  -- registry would refuse to parse must never reach the table: the resolver
  -- could then hold a key nothing can look up.
  if new.provider = 'github'
     and v_handle !~ '^github:[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$' then
    raise warning 'handle_new_identity: github identity % has an unparseable login %',
      new.provider_id, v_handle;
    return new;
  end if;

  -- Newest proven control wins. Handles move between people (GitHub logins get
  -- renamed and re-registered, X handles get released), and the person standing
  -- in front of Supabase right now has just proven control of this one. Without
  -- this delete the unique index on handle_normalized would reject their row
  -- and leave the payments flowing to the previous owner.
  --
  -- Scoped to OTHER users. With the unique index on handle_normalized live,
  -- two rows can never share a handle, so this scope does not decide between
  -- "one row" and "two rows": it decides whose row the delete is allowed to
  -- touch. google and email both canonicalize to the bare email address, so
  -- a user linking email after google hits this clause on their own existing
  -- row, and `user_id <> new.user_id` skips the delete rather than removing
  -- it. The insert below then raises a unique violation on handle_normalized
  -- (not on the (provider, subject) conflict target, which never matches
  -- because the two rows differ in both columns), the exception block below
  -- swallows it, and the email identity is simply never inserted as its own
  -- row. The user keeps their original google row.
  delete from public.handles
   where handle_normalized = v_handle
     and user_id <> new.user_id
     and (provider, subject) <> (new.provider, new.provider_id)
   returning user_id into v_evicted;

  -- A handle changing hands silently is the kind of thing that only gets
  -- noticed when someone's payments stop arriving. handle_normalized is
  -- unique, so there is at most one evicted row to name.
  if v_evicted is not null then
    raise notice 'handle_new_identity: % moved from user % to user %',
      v_handle, v_evicted, new.user_id;
  end if;

  insert into public.handles (user_id, provider, subject, handle, handle_normalized)
  values (new.user_id, new.provider, new.provider_id, v_handle, v_handle)
  on conflict (provider, subject) do update
    set handle = excluded.handle,
        handle_normalized = excluded.handle_normalized;

  return new;
exception when unique_violation then
  -- Live once handles_unique.sql has been applied: a row inserted between the
  -- delete above and this insert raises here. Swallowing it keeps the identity
  -- link itself from failing; the loser retries on their next sign-in.
  return new;
end;
$function$;
