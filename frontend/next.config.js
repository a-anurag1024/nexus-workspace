/** @type {import('next').NextConfig} */
const nextConfig = {
  // Export as a fully-static site (no Node.js server required).
  // All pages must be statically renderable; Server Actions and
  // Next.js API routes are not supported with this setting.
  output: 'export',

  // Optional: add a trailing slash so that S3/CloudFront can serve
  // index.html files from directory-style paths.
  trailingSlash: true,

  // Disable the built-in image optimisation server (not compatible
  // with `output: 'export'`).
  images: {
    unoptimized: true,
  },

  // Don't fail the build on TypeScript or ESLint errors.
  typescript: { ignoreBuildErrors: true },
  eslint: { ignoreDuringBuilds: true },
};

module.exports = nextConfig;
