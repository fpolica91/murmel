/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The Better Auth handler uses the `pg` driver, which must stay external
  // to the server bundle (it is a native-ish dependency, not bundleable).
  serverExternalPackages: ["pg"],
};

export default nextConfig;
