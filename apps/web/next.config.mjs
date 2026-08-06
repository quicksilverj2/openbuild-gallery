/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Fully static export (-> apps/web/out) so the gallery can be served by a
  // Render Static Site: always-on, free, no cold start. The app is entirely
  // client-rendered (it fetches the API at runtime), so nothing needs a server.
  output: 'export',
};

export default nextConfig;
