import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

// Build connect-src from the runtime endpoints the app actually talks to.
// Values come from NEXT_PUBLIC_* env at build time; we widen host-only so a
// changed path or port still matches, and derive the Supabase realtime (wss)
// origin from its https origin.
function originOf(url: string | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

// Mirror the same fallback the Supabase client uses (src/lib/supabase/*.ts)
// so connect-src stays correct even when NEXT_PUBLIC_SUPABASE_URL is unset.
const supabaseOrigin = originOf(
  process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "https://fxtxvierohxvvusmhkoa.supabase.co",
);
const supabaseWs = supabaseOrigin?.replace(/^https:/, "wss:") ?? null;

const connectSrc = [
  "'self'",
  originOf(process.env.NEXT_PUBLIC_SOROBAN_RPC_URL),
  originOf(process.env.NEXT_PUBLIC_RESOLVER_URL),
  supabaseOrigin,
  supabaseWs,
  // Next.js dev server uses a websocket for HMR / React Fast Refresh.
  isDev ? "ws:" : null,
].filter(Boolean);

// snarkjs + ffjavascript instantiate WebAssembly in the browser, which needs
// 'wasm-unsafe-eval'. Dev additionally needs 'unsafe-eval' for HMR. Next.js
// injects inline bootstrap scripts and inline styles, so without a
// nonce+middleware setup 'unsafe-inline' is required for scripts and styles.
const scriptSrc = [
  "'self'",
  "'unsafe-inline'",
  "'wasm-unsafe-eval'",
  isDev ? "'unsafe-eval'" : null,
].filter(Boolean);

const csp = [
  `default-src 'self'`,
  `script-src ${scriptSrc.join(" ")}`,
  `style-src 'self' 'unsafe-inline'`,
  `img-src 'self' data: blob:`,
  `font-src 'self' data:`,
  `connect-src ${connectSrc.join(" ")}`,
  `worker-src 'self' blob:`,
  `frame-ancestors 'none'`,
  `base-uri 'self'`,
  `form-action 'self'`,
  `object-src 'none'`,
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains; preload",
  },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  {
    key: "Permissions-Policy",
    value: "camera=(), microphone=(), geolocation=(), payment=()",
  },
];

const nextConfig: NextConfig = {
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  // stellar-sdk uses Node.js APIs; polyfill in browser bundle
  webpack: (config, { isServer }) => {
    if (!isServer) {
      config.resolve.fallback = {
        ...config.resolve.fallback,
        fs: false,
        net: false,
        tls: false,
        crypto: false,
        stream: false,
        http: false,
        https: false,
        zlib: false,
        path: false,
        os: false,
      };
    }
    return config;
  },
};

export default nextConfig;
