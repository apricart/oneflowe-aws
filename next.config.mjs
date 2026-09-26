/** @type {import('next').NextConfig} */
const nextConfig = {

  // Build output directory. Overridable only so a second dev server can run
  // beside the one a developer already has open: the dev-server lock lives at
  // `<distDir>/dev/lock`, and Next refuses to start twice against the same one.
  // The Playwright suite sets it (`playwright.config.ts`) so `npm run e2e` does
  // not require stopping `npm run dev`. Unset everywhere else, which is `.next`.
  distDir: process.env.NEXT_DIST_DIR || '.next',

  // Security: Remove X-Powered-By header
  poweredByHeader: false,
  typescript: {
    // ignoreBuildErrors: false,
  },
  images: {
    // Enabled for better performance (WebP, resizing)
    unoptimized: false,
  },
  // Performance optimizations
  experimental: {
    optimizePackageImports: ['lucide-react', '@radix-ui/react-icons'],
  },
  turbopack: {
    rules: {
      '*.svg': {
        loaders: ['@svgr/webpack'],
        as: '*.js',
      },
    },
  },
  // Enable compression
  compress: true,
  // Optimize bundle — split into smaller chunks to prevent ChunkLoadError timeouts
  webpack: (config, { dev, isServer }) => {
    if (!dev && !isServer) {
      config.optimization.splitChunks = {
        chunks: 'all',
        maxInitialRequests: 25,
        minSize: 20000,
        cacheGroups: {
          reactVendor: {
            test: /[\\/]node_modules[\\/](react|react-dom|next|scheduler)[\\/]/,
            name: 'react-vendor',
            priority: 40,
            chunks: 'all',
          },
          uiVendor: {
            test: /[\\/]node_modules[\\/](@radix-ui|framer-motion|lucide-react|class-variance-authority|clsx|tailwind-merge|cmdk|vaul|sonner)[\\/]/,
            name: 'ui-vendor',
            priority: 30,
            chunks: 'all',
          },
          dataVendor: {
            test: /[\\/]node_modules[\\/](swr|recharts|date-fns|xlsx|jspdf|drizzle-orm|d3-.*)[\\/]/,
            name: 'data-vendor',
            priority: 20,
            chunks: 'all',
          },
          vendor: {
            test: /[\\/]node_modules[\\/]/,
            name: 'vendors',
            priority: 10,
            chunks: 'all',
          },
        },
      }
    }
    return config
  },
  // Native (.node) addon: must stay external so webpack/turbopack never try
  // to bundle the binary, and so output-file-tracing copies it into the
  // standalone build.
  serverExternalPackages: ['@node-rs/bcrypt'],
  output: 'standalone',
}

export default nextConfig
