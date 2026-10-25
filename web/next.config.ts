import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== "production";

/** Origins of the per-network API and WS from env (empty = same origin, already covered by 'self'). */
function apiOrigins(): string[] {
  const urls = [
    process.env.NEXT_PUBLIC_API_URL,
    process.env.NEXT_PUBLIC_API_URL_DEVNET,
    process.env.NEXT_PUBLIC_API_URL_MAINNET,
    process.env.NEXT_PUBLIC_WS_URL_DEVNET,
    process.env.NEXT_PUBLIC_WS_URL_MAINNET,
    process.env.NEXT_PUBLIC_API_URL_HOOD,
    process.env.NEXT_PUBLIC_WS_URL_HOOD,
  ];
  const out = new Set<string>();
  for (const u of urls) {
    if (!u) continue;
    try {
      const { protocol, host } = new URL(u);
      out.add(`${protocol}//${host}`);
      // A WS base is derived from the REST base when not set (lib/api/client.ts).
      if (protocol === "https:" || protocol === "http:") out.add(`${protocol === "https:" ? "wss:" : "ws:"}//${host}`);
    } catch {
      throw new Error(`Invalid API/WS URL in env: ${u}`);
    }
  }
  return [...out];
}

const api = apiOrigins().join(" ");

// Next's App Router bootstraps with inline scripts. Nonces would force dynamic rendering, which
// cacheComponents/PPR can't do, so inline scripts are allowed but nothing from other origins is.
const csp = [
  "default-src 'self'",
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ""}`,
  "style-src 'self' 'unsafe-inline'", // Motion writes inline styles
  `img-src 'self' data: blob:${api ? " " + api : ""}`,
  "font-src 'self'",
  `connect-src 'self'${api ? " " + api : ""}`,
  "worker-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "manifest-src 'self'",
  ...(isDev ? [] : ["upgrade-insecure-requests"]),
].join("; ");

const securityHeaders = [
  { key: "Content-Security-Policy", value: csp },
  { key: "Referrer-Policy", value: "no-referrer" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
  { key: "Cross-Origin-Resource-Policy", value: "same-origin" },
  {
    key: "Permissions-Policy",
    value:
      "camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), hid=(), " +
      "accelerometer=(), gyroscope=(), magnetometer=(), browsing-topics=(), interest-cohort=()",
  },
  ...(isDev ? [] : [{ key: "Strict-Transport-Security", value: "max-age=63072000; includeSubDomains" }]),
];

const nextConfig: NextConfig = {
  // Build-time feature switches, always inlined (an unset NEXT_PUBLIC_* var is otherwise left as a runtime
  // lookup, and the code behind it is not dropped from the bundle).
  env: {
    NEXT_PUBLIC_MOCK_FAIR_LAUNCH: process.env.NEXT_PUBLIC_MOCK_FAIR_LAUNCH ?? "",
    // API v0.18 Robinhood Chain origin (default off: no hood code or names in the bundle).
    NEXT_PUBLIC_HOOD: process.env.NEXT_PUBLIC_HOOD ?? "",
    NEXT_PUBLIC_FAIR_LAUNCH_BUILD: process.env.NEXT_PUBLIC_FAIR_LAUNCH_BUILD ?? "",
    NEXT_PUBLIC_MOCK_CREATE_DISABLED: process.env.NEXT_PUBLIC_MOCK_CREATE_DISABLED ?? "",
    // Dev-only failure injection (lib/api/chaos.ts): must be inlined so a public build drops it.
    NEXT_PUBLIC_MOCK_CHAOS: process.env.NEXT_PUBLIC_MOCK_CHAOS ?? "",
    NEXT_PUBLIC_MOCK_CHAT: process.env.NEXT_PUBLIC_MOCK_CHAT ?? "",
    NEXT_PUBLIC_MOCK_NOOP: process.env.NEXT_PUBLIC_MOCK_NOOP ?? "",
    NEXT_PUBLIC_MOCK_DISCOVERY: process.env.NEXT_PUBLIC_MOCK_DISCOVERY ?? "",
    NEXT_PUBLIC_COVER_TRAFFIC: process.env.NEXT_PUBLIC_COVER_TRAFFIC ?? "",
  },
  // Dev server only: the live devnet stand is opened at http://127.0.0.1:3100 (API CORS lists that origin).
  // Without this Next 16 refuses its HMR socket from 127.0.0.1 and the page never hydrates.
  allowedDevOrigins: ["127.0.0.1"],
  cacheComponents: true,
  partialPrefetching: true,
  poweredByHeader: false,
  // next/image is not used anywhere: no /_next/image optimizer endpoint to expose.
  images: { unoptimized: true },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
