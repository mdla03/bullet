import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";
import { SUPABASE_ANON_KEY, SUPABASE_URL, timeoutFetch } from "@/lib/supabase/config";

/** Refresh the Supabase session on every request so Server Components see fresh cookies. */
export async function middleware(request: NextRequest) {
  // dashboard.<domain> serves the admin dashboard at its root. Every other
  // path (auth callback, static assets) stays as-is so sign-in works there.
  const host = (request.headers.get("host") ?? "").split(":")[0];
  let rewriteUrl: URL | null = null;
  if (host.startsWith("dashboard.") && request.nextUrl.pathname === "/") {
    rewriteUrl = new URL("/dashboard", request.nextUrl);
  }
  const newResponse = () =>
    rewriteUrl
      ? NextResponse.rewrite(rewriteUrl, { request })
      : NextResponse.next({ request });

  let response = newResponse();

  // Without Supabase config there is no session to refresh. Skip instead of
  // letting createServerClient throw, which would 500 every request.
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    return response;
  }

  const supabase = createServerClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    global: { fetch: timeoutFetch() },
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = newResponse();
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // Touch the user to trigger a token refresh when needed. A failure here
  // (network, bad config) must not take down the request.
  try {
    await supabase.auth.getUser();
  } catch {
    // Session refresh failed; serve the request unauthenticated.
  }

  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico|.*\\.svg$).*)"],
};
