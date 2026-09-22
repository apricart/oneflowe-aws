import type { Metadata } from 'next'
import Script from 'next/script'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'

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
        <Script src="/theme-init.js" strategy="beforeInteractive" />
      </head>
      <body className={`font-sans ${GeistSans.variable} ${GeistMono.variable} selection:bg-indigo-100 selection:text-indigo-900`} suppressHydrationWarning>
        <ThemeProvider>
          <AuthSessionProvider>
            <SWRProvider>
              {children}
              <Toaster />
            </SWRProvider>
          </AuthSessionProvider>
        </ThemeProvider>
      </body>
    </html>
  )
}
