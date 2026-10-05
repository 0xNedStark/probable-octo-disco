import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Workspace packages ship TypeScript source.
  transpilePackages: ['@solar/calc', '@solar/db', '@solar/domain', '@solar/integrations'],
  serverExternalPackages: ['postgres'],
  experimental: {
    // Bill uploads are capped at 10 MB; leave room for multipart overhead.
    serverActions: { bodySizeLimit: '11mb' },
  },
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          { key: 'X-Frame-Options', value: 'DENY' },
        ],
      },
    ];
  },
};

export default nextConfig;
