/** @type {import('next').NextConfig} */

// Baseline security headers on every route. The CSP tightens the directives
// that carry no breakage risk for Next — object-src/base-uri/form-action close
// off plugin, base-tag-injection, and form-exfiltration XSS vectors on top of
// the existing anti-clickjacking frame-ancestors. A nonce-based script-src /
// default-src 'self' is the remaining follow-up (needs per-request nonce
// middleware so Next's inline bootstrap/styles keep working).
const csp = [
  "frame-ancestors 'none'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
].join("; ");
const securityHeaders = [
  { key: "X-Frame-Options", value: "DENY" },
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
  { key: "Content-Security-Policy", value: csp },
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
