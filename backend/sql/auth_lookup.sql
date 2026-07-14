-- identity_providers_for_email(email) — returns the auth providers linked to
-- an email address. Used by the register flow to detect OAuth-only accounts
-- (Google/X sign-in with no email/password identity), where Supabase silently
-- drops magic-link OTP requests, so the UI can prompt the correct provider.
--
-- SECURITY: information disclosure risk (email enumeration). Enforce two
-- guards: (1) revoke direct exec from anon/authenticated so it can only be
-- called from the backend service role, and (2) the backend endpoint that
-- wraps it MUST rate-limit per IP.

create or replace function public.identity_providers_for_email(p_email text)
returns text[]
language sql
security definer
set search_path = public
stable
as $$
  select coalesce(
    array_agg(distinct i.provider order by i.provider),
    array[]::text[]
  )
  from auth.identities i
  left join auth.users u on u.id = i.user_id
  where lower(coalesce(u.email, '')) = lower(p_email)
     or lower(coalesce(i.identity_data->>'email', '')) = lower(p_email);
$$;

revoke all on function public.identity_providers_for_email(text) from public;
revoke all on function public.identity_providers_for_email(text) from anon, authenticated;
grant execute on function public.identity_providers_for_email(text) to service_role;
