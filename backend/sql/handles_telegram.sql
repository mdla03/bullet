-- Telegram handle linking, as a database function.
--
-- APPLY ORDER: after handles_schema.sql, handles_github.sql,
-- handles_unique.sql, handles_avatar.sql and handles_discord.sql. This file
-- adds a new function and does NOT replace public.handle_new_identity(), so it
-- is safe to apply at any point after those.
--
-- WHY THIS EXISTS. Every other handle type gets its row from the
-- public.handle_new_identity() trigger on auth.identities. Telegram is not a
-- Supabase OAuth provider, so no identity row is ever written and the trigger
-- never fires; backend/src/telegram.ts proves control itself by checking the
-- Login Widget's HMAC, then has to write the row by hand.
--
-- That hand-written version lived in backend/src/store.ts as a DELETE followed
-- by an UPSERT: two PostgREST round trips with no transaction between them.
-- Two people proving control of the same released Telegram username at the
-- same time could interleave those four statements, and the trigger's own
-- rules (which run inside a single statement's transaction) did not apply to
-- it. Moving the body here makes the Telegram path atomic and puts it under
-- the same rules as every other provider.
--
-- The body below is the tail of public.handle_new_identity() in
-- handles_avatar.sql (the delete, the eviction notice, the upsert and the
-- unique_violation handler), with the provider fixed to 'telegram' and the
-- handle/avatar taken as arguments instead of derived from identity_data.
-- Telegram's username charset and the namespaced 'telegram:<name>' canonical
-- form are validated in the backend by the registry's own parseTelegram, the
-- same single source of truth the resolver looks handles up with, so this
-- function does not re-derive them.

create or replace function public.link_telegram_handle(
  p_user_id uuid,
  p_subject text,
  p_handle  text,
  p_avatar  text
)
returns boolean
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_evicted uuid;
begin
  -- Only an https URL, matching the trigger's guard: /resolve is public and
  -- unauthenticated, so nothing else belongs in a column it serves back out.
  if p_avatar is not null and p_avatar !~ '^https://' then
    p_avatar := null;
  end if;

  -- Newest proven control wins. Telegram usernames get released and
  -- re-registered, and the person who just passed the HMAC check has proven
  -- control of this one now. Scoped to OTHER users, and excluding this very
  -- row, so re-linking your own handle is an update rather than a
  -- delete-then-insert of your own row.
  delete from public.handles
   where handle_normalized = p_handle
     and user_id <> p_user_id
     and (provider, subject) <> ('telegram', p_subject)
   returning user_id into v_evicted;

  if v_evicted is not null then
    raise notice 'link_telegram_handle: % moved from user % to user %',
      p_handle, v_evicted, p_user_id;
  end if;

  insert into public.handles (user_id, provider, subject, handle, handle_normalized, avatar_url)
  values (p_user_id, 'telegram', p_subject, p_handle, p_handle, p_avatar)
  on conflict (provider, subject) do update
    set user_id           = excluded.user_id,
        handle            = excluded.handle,
        handle_normalized = excluded.handle_normalized,
        avatar_url        = excluded.avatar_url;

  return true;
exception when unique_violation then
  -- A competing row inserted between the delete and the insert. The trigger
  -- swallows this so the identity link itself does not fail; here there is no
  -- wider operation to protect, so report it and let the caller return an
  -- error the user can retry.
  raise warning 'link_telegram_handle: % lost a race to another linker', p_handle;
  return false;
end;
$function$;

-- Same posture as the handles table itself: service-role only. The backend
-- calls this after verifying the widget HMAC; a browser holding the anon key
-- must never be able to claim a Telegram handle without that check.
revoke all on function public.link_telegram_handle(uuid, text, text, text) from anon, authenticated;
