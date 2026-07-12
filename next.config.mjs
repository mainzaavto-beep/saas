/** @type {import('next').NextConfig} */
const nextConfig = {
  // pg — нативный модуль, Next.js должен его внештатно обрабатывать (не webpack'ать)
  experimental: { serverComponentsExternalPackages: ['pg'] },
};
export default nextConfig;
