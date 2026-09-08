import type { SVGProps } from "react";
import {
  enabledHandleTypes,
  handleTypeForCanonical,
  handleTypeForIdentityProvider,
  type HandleProof,
  type HandleType,
  type HandleTypeId,
  type OAuthProviderId,
} from "@zeekpay/shared";
import { GithubIcon, GoogleIcon, MailIcon, XBrandIcon } from "@/components/icons";

/** The OAuth-backed variant of a handle proof. Its `provider` is the registry's
 *  own `OAuthProviderId`, every member of which is also a Supabase `Provider`,
 *  so register/account can pass it straight into signInWithOAuth /
 *  linkIdentity. */
export type OAuthProof = Extract<HandleProof, { type: "supabase-oauth" }>;

/** Narrows a handle type's proof to the OAuth-backed variant. The narrowing is
 *  real: it restates a member of the union rather than asserting an unrelated
 *  provider type onto it. */
export function isOAuthProof(p: HandleProof): p is OAuthProof {
  return p.type === "supabase-oauth";
}

/** An enabled handle type whose proof is OAuth-backed. */
export type OAuthHandleType = Omit<HandleType, "proof"> & { proof: OAuthProof };

/** OAuth handle types the register/account UI offers, in registry order. The
 *  single source for "which providers do we sign in with": no screen should
 *  carry its own provider list. */
export function oauthHandleTypes(): OAuthHandleType[] {
  return enabledHandleTypes().flatMap((h) =>
    isOAuthProof(h.proof) ? [{ ...h, proof: h.proof }] : []
  );
}

/** Registry OAuth provider id for a raw auth.identities.provider value
 *  ("twitter_v2" -> "x"), or null when no enabled OAuth type claims it. */
export function oauthProviderForIdentity(provider: string): OAuthProviderId | null {
  const handleType = handleTypeForIdentityProvider(provider);
  return handleType && handleType.enabled && isOAuthProof(handleType.proof)
    ? handleType.proof.provider
    : null;
}

/** A stored handle as it should read on screen. Canonical forms are namespaced
 *  so they stay unique in one column ("github:torvalds"); the registry's
 *  format() strips that back off for display, and is the identity function for
 *  every type whose canonical form is already the display form. */
export function displayHandle(provider: string, handle: string | null | undefined): string {
  if (!handle) return "";
  return handleTypeForIdentityProvider(provider)?.format(handle) ?? handle;
}

/** Same, for a canonical handle whose provider is not to hand: the send box
 *  holds one after the sender picks a /resolve candidate. Anything the
 *  registry does not own comes back unchanged, so a half-typed string in the
 *  same field still renders as itself. */
export function displayCanonical(canonical: string): string {
  return handleTypeForCanonical(canonical)?.format(canonical) ?? canonical;
}

// Icons for the OAuth-backed handle types. Discord/telegram stay hidden
// (registry enabled: false), so they're never looked up here.
export const OAUTH_ICON: Partial<
  Record<HandleTypeId, (p: SVGProps<SVGSVGElement>) => React.ReactElement>
> = {
  google: GoogleIcon,
  x: XBrandIcon,
  github: GithubIcon,
};

export function providerIcon(
  provider: string
): (p: SVGProps<SVGSVGElement>) => React.ReactElement {
  const handleType = handleTypeForIdentityProvider(provider);
  return (handleType && OAUTH_ICON[handleType.id]) || MailIcon;
}

// Sort key: registry order (Google, X, email, GitHub, …), unknown last.
const PROVIDER_RANK: Record<string, number> = Object.fromEntries(
  enabledHandleTypes().flatMap((h, i) => h.identityProviders.map((p) => [p, i]))
);
export function providerRank(provider: string): number {
  return PROVIDER_RANK[provider] ?? 99;
}
