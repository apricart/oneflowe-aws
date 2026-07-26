/** @type {import('next').NextConfig} */
const nextConfig = {
  // Security: Remove X-Powered-By header
  poweredByHeader: false,
  eslint: {
    ignoreDuringBuilds: true,
  },
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
    turbo: {
      rules: {
        '*.svg': {
          loaders: ['@svgr/webpack'],
          as: '*.js',
        },
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
}

export default nextConfig
