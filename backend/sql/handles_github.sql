-- Adds GitHub to the trigger that turns a linked Supabase identity into a
-- handles row. Applied to the project on 2026-09-08. Mirrors the deployed
-- function; the only change is the github branch. Canonical GitHub handle is
-- the bare lowercase username, matching parseGithub in shared/src/handles.ts.
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
