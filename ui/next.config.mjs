/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Emit a self-contained server bundle under .next/standalone for a lean
  // production Docker image (see ui/Dockerfile). Harmless for other deploy
  // targets (e.g. Vercel ignores it).
  output: "standalone",
  // The Better Auth handler uses the `pg` driver, which must stay external
  // to the server bundle (it is a native-ish dependency, not bundleable).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
