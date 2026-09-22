-- Adds Discord to the trigger that turns a linked Supabase identity into a
-- handles row, namespaced like github (see handles_github.sql for why bare-
-- name types need a namespace).
--
-- APPLY ORDER: handles_schema.sql, handles_github.sql, handles_unique.sql,
-- handles_avatar.sql, then THIS FILE last. This file's CREATE OR REPLACE
-- supersedes handles_avatar.sql's function; do not re-apply that file's
-- function body after this one, or the discord branch disappears again.
-- handles_avatar.sql carries a one-line pointer back to this file.
--
-- WHAT THIS CHANGES:
--   public.handle_new_identity() gains an `elsif new.provider = 'discord'`
--   branch, identical in shape to the existing github branch: it derives
--   v_handle as 'discord:' || lower(username), then a charset guard mirroring
--   parseDiscord in shared/src/handles.ts rejects (raise warning, return)
--   anything the registry could not parse back. Nothing else in the function
--   changes: the avatar handling, the newest-wins eviction, the upsert and
--   the unique_violation swallow are all unchanged from handles_avatar.sql.
--
-- FIELD SOURCE (what identity_data carries for a Discord identity):
-- LIVE-VERIFIED 2026-09-22 from a real Discord sign-in (sendbulletxyz,
-- provider_id 1548525755007242271, project fxtxvierohxvvusmhkoa), the same
-- way handles_github.sql's branch was proven end to end. identity_data's
-- top-level keys were: iss, sub, name, email, picture, full_name, avatar_url,
-- provider_id, custom_claims (nested: global_name only), email_verified,
-- phone_verified. No user_name or preferred_username key exists for this
-- provider (unlike github and x, which set both).
--
--   `name` held "sendbulletxyz#0" - GoTrue's Discord provider still appends
--   "#<discriminator>" even under Discord's post-discriminator username
--   system, where "0" means "no discriminator" rather than being omitted. The
--   unique, charset-safe username is recovered by stripping that suffix:
--   split_part(identity_data->>'name', '#', 1). This handles both the legacy
--   "user#1234" form and the new-system "user#0" form identically.
--
--   `full_name` held "sendbulletxyz" and looked like a clean username, but
--   per GoTrue's Discord provider source that field carries Discord's
--   *global* (display) name: free text, not unique, can contain spaces or
--   Unicode. It only happened to equal the username on this test account -
--   custom_claims.global_name ("Bullet" here) is the actual global name and
--   differs from full_name, which would not be true if full_name were really
--   sourced from global_name. Either way, full_name is not a safe handle
--   source and must not be used.
--
-- ── the trigger function ─────────────────────────────────────────────────────
--
-- Identical to the function in handles_avatar.sql except for the discord
-- branch in the if/elsif chain and its charset guard below the github one.
-- Every other branch, guard and comment is unchanged from that file; see it
-- (and handles_github.sql) for the history of the rest of this function.
create or replace function public.handle_new_identity()
returns trigger
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_handle text;
  v_avatar text;
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
  elsif new.provider = 'discord' then
    -- See this file's header FIELD SOURCE note. Namespaced for the same
    -- collision reason as github: a bare "alice" from Discord must not read
    -- as the same handle as a bare "alice" from GitHub. split_part strips
    -- GoTrue's "#<discriminator>" suffix (see FIELD SOURCE for why full_name
    -- is not used instead).
    v_handle := 'discord:' || lower(split_part(new.identity_data->>'name', '#', 1));
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

  -- Charset guard, mirroring parseDiscord in shared/src/handles.ts: 2-32
  -- chars, lowercase letters/digits/underscore/period, no consecutive
  -- periods. Postgres's regex engine supports the negative lookahead this
  -- needs (ARE mode, the default).
  if new.provider = 'discord'
     and v_handle !~ '^discord:(?!.*\.\.)[a-z0-9._]{2,32}$' then
    raise warning 'handle_new_identity: discord identity % has an unparseable username %',
      new.provider_id, v_handle;
    return new;
  end if;

  -- Avatar: google, github and x (avatar_url or, on some providers, picture).
  -- Kept only when it is an https URL, so a provider sending something odd
  -- (a data: URI, a relative provider-internal path, an empty string) never
  -- lands in a column the unauthenticated resolver serves back out.
  v_avatar := coalesce(new.identity_data->>'avatar_url', new.identity_data->>'picture');
  if v_avatar is not null and v_avatar !~ '^https://' then
    v_avatar := null;
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

  insert into public.handles (user_id, provider, subject, handle, handle_normalized, avatar_url)
  values (new.user_id, new.provider, new.provider_id, v_handle, v_handle, v_avatar)
  on conflict (provider, subject) do update
    set handle = excluded.handle,
        handle_normalized = excluded.handle_normalized,
        avatar_url = excluded.avatar_url;

  return new;
exception when unique_violation then
  -- Live once handles_unique.sql has been applied: a row inserted between the
  -- delete above and this insert raises here. Swallowing it keeps the identity
  -- link itself from failing; the loser retries on their next sign-in.
  return new;
end;
$function$;
