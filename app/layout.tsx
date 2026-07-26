import type { Metadata } from 'next'
import { Inter, JetBrains_Mono } from 'next/font/google'

const inter = Inter({
  subsets: ['latin'],
  variable: '--font-inter',
})

const jetbrainsMono = JetBrains_Mono({
  subsets: ['latin'],
  variable: '--font-jetbrains-mono',
})

import { Analytics } from '@vercel/analytics/next'
import { AuthSessionProvider } from '@/components/session-provider'
import { Toaster } from '@/components/ui/toaster'
import { ThemeProvider } from '@/components/theme-provider'
import { SWRProvider } from '@/components/swr-provider'
import './globals.css'

export const metadata: Metadata = {
  title: 'ONE FLOWE',
  description: 'Created by Swenta Solutions',
  icons: {
    icon: '/logo-web.png',
    shortcut: '/logo-web.png',
    apple: '/logo-web.png',
  },
  manifest: '/manifest.json',
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/logo-web.png" type="image/png" />
        <link rel="shortcut icon" href="/logo-web.png" type="image/png" />
        <link rel="apple-touch-icon" href="/logo-web.png" />
        <meta name="theme-color" content="#1e3a8a" />
        <script src="/theme-init.js" />
      </head>
      <body className={`font-sans ${inter.variable} ${jetbrainsMono.variable} selection:bg-indigo-100 selection:text-indigo-900`} suppressHydrationWarning>
        <ThemeProvider>
          <AuthSessionProvider>
            <SWRProvider>
              {children}
              <Toaster />
              <Analytics />
            </SWRProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
