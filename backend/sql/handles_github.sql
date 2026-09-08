-- Adds GitHub to the trigger that turns a linked Supabase identity into a
-- handles row. Mirrors the deployed function; the only change is the github
-- branch. Canonical GitHub handle is the bare lowercase username, matching
-- parseGithub in shared/src/handles.ts.
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
-- That single row closes three separate unknowns at once: the provider is
-- configured in Supabase Auth, the trigger fires on the github branch, and
-- identity_data really does carry user_name/preferred_username. The last one
-- was the risk worth testing: if it carried neither, v_handle would be null,
-- the guard below would return early, and NO handle row would be created with
-- no error raised anywhere. Silent. Re-test this way, not by reading the
-- function, after any change to the branch.
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
begin
  if new.provider in ('twitter', 'twitter_v2', 'x') then
    -- X OAuth 2.0 puts the handle in preferred_username; OAuth 1.0a in user_name.
    v_handle := '@' || lower(coalesce(new.identity_data->>'user_name',
                                      new.identity_data->>'preferred_username'));
  elsif new.provider in ('google', 'email') then
    v_handle := lower(new.identity_data->>'email');
  elsif new.provider = 'github' then
    -- Supabase's GitHub provider sets user_name and preferred_username to the login.
    v_handle := lower(coalesce(new.identity_data->>'user_name',
                               new.identity_data->>'preferred_username'));
  else
    return new;
  end if;

  if v_handle is null or v_handle = '@' or v_handle = '' then
    return new;
  end if;

  insert into public.handles (user_id, provider, subject, handle, handle_normalized)
  values (new.user_id, new.provider, new.provider_id, v_handle, v_handle)
  on conflict (provider, subject) do update
    set handle = excluded.handle,
        handle_normalized = excluded.handle_normalized;

  return new;
exception when unique_violation then
  return new;
end;
$function$;
