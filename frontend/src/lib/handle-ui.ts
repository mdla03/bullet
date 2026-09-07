import type { Provider } from "@supabase/supabase-js";
import type { SVGProps } from "react";
import {
  enabledHandleTypes,
  handleTypeForIdentityProvider,
  type HandleProof,
  type HandleTypeId,
} from "@zeekpay/shared";
import { GithubIcon, GoogleIcon, MailIcon, XBrandIcon } from "@/components/icons";

/** Narrows a handle type's proof to the OAuth-backed variant, typing its
 *  provider as a Supabase `Provider` (register/account pass it straight into
 *  signInWithOAuth / linkIdentity). */
export function isOAuthProof(
  p: HandleProof
): p is { type: "supabase-oauth"; provider: Provider } {
  return p.type === "supabase-oauth";
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
