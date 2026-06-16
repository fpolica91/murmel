/** @type {import('next').NextConfig} */

// Baseline security headers on every route. CSP is limited to frame-ancestors
// (anti-clickjacking) to avoid breaking Next's inline styles / font loading; a
// full default-src policy is a follow-up.
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
  {
    key: "Strict-Transport-Security",
    value: "max-age=63072000; includeSubDomains",
  },
];

const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle under .next/standalone for a lean
  // production Docker image (see ui/Dockerfile). Harmless for other deploy
  // targets (e.g. Vercel ignores it).
  output: "standalone",
  // The Better Auth handler uses the `pg` driver, which must stay external
  // to the server bundle (it is a native-ish dependency, not bundleable).
  serverExternalPackages: ["pg"],
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
