import type { NextConfig } from 'next';
import { serverApiOrigin } from './src/lib/server-api-origin';

const apiOrigin = serverApiOrigin();
const config: NextConfig = {
  output: 'standalone',
  poweredByHeader: false,
  async rewrites() {
    // Exact App Routes, including the streaming upload endpoint, run first.
    return { fallback: [{ source: '/api/v1/:path*', destination: `${apiOrigin}/v1/:path*` }] };
  },
};
export default config;
