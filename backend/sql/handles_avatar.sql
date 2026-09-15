-- SUPERSEDED: the current public.handle_new_identity() function lives in
-- handles_discord.sql from that revision on (it adds the discord branch); do
-- not apply this file's function body after handles_discord.sql has been
-- applied.
--
-- Adds an avatar photo to public.handles, so the resolver can hand the
-- sender a face for a recipient (and for each ambiguity candidate) instead of
-- just a bare handle string.
--
-- APPLY ORDER: handles_schema.sql, then handles_github.sql, then
-- handles_unique.sql, then THIS FILE last. This file's CREATE OR REPLACE
-- supersedes handles_github.sql's function; do not re-apply that file's
-- function body after this one, or avatar_url stops being written again.
--
-- WHAT THIS CHANGES:
--   1. public.handles gains an avatar_url column.
--   2. public.handle_new_identity() is replaced with a version identical to
--      the one in handles_github.sql except it also reads an avatar URL out
--      of identity_data and writes it, both on first insert and on the
--      on-conflict update (so a re-sign-in refreshes a changed photo, and
--      clears one the provider stops sending).
--   3. A one-time backfill fills avatar_url for handles rows created before
--      this revision, from the same auth.identities data the trigger would
--      have used if it had run at insert time.
--
-- WHY BOTH avatar_url AND picture. Supabase populates identity_data's
-- avatar_url key for google and github. X's OAuth 2.0 identity_data instead
-- carries the photo under picture (some providers use that key name instead
-- of avatar_url); coalesce(avatar_url, picture) below covers both without
-- needing a per-provider branch.
--
-- PRIVACY NOTE: /resolve is a public, unauthenticated endpoint (rate-limited,
-- not access-controlled) that anyone can query with a guessed or discovered
-- handle. Publishing avatar_url through it means the avatar is served to
-- anyone who resolves the handle, not just the sender who already knows the
-- recipient. Only the https:// URL the provider already serves publicly is
-- stored (the same photo shown on the person's GitHub/Google/X profile), and
-- the https:// check keeps anything else (a data: URI, a provider-internal
-- path, a null) out of a column the resolver serves unauthenticated.
--
-- ── the table ─────────────────────────────────────────────────────────────────
alter table public.handles add column if not exists avatar_url text;

-- ── the trigger function ─────────────────────────────────────────────────────
--
-- Identical to the function in handles_github.sql except for the avatar
-- handling: v_avatar's declaration, assignment, the https:// guard, and its
-- appearance in the insert column list and the on-conflict update. Every
-- other branch, guard and comment is unchanged from that file; see it for the
-- history of the non-avatar logic.
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

-- ── one-time backfill ────────────────────────────────────────────────────────
-- Fills avatar_url for rows written before this revision (the trigger above
-- only sets it on the next sign-in). Idempotent: `and h.avatar_url is null`
-- makes a second run a no-op, and only https URLs are ever written.
update public.handles h
   set avatar_url = sub.url
  from (
    select i.provider, i.provider_id,
           coalesce(i.identity_data->>'avatar_url', i.identity_data->>'picture') as url
      from auth.identities i
  ) sub
 where h.provider = sub.provider
   and h.subject = sub.provider_id
   and sub.url like 'https://%'
   and h.avatar_url is null;
