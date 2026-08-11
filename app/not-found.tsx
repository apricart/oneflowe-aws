"use client"
import { Button } from "@/components/ui/button"
import { Card } from "@/components/ui/card"
import Link from "next/link"
import { Home,ArrowLeft } from "lucide-react"

export default function NotFound() {
  return (
    <main className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50 to-white dark:from-slate-950 dark:to-slate-900 p-4">
      <Card className="w-full max-w-lg p-8 space-y-6 text-center">
        <div className="space-y-4">
          <div className="text-6xl font-bold text-slate-900 dark:text-white">404</div>
          <h1 className="text-3xl font-bold text-slate-900 dark:text-white">Page Not Found</h1>
          <p className="text-muted-foreground text-lg">
            Sorry, the page you're looking for doesn't exist or has been moved.
          </p>
        </div>

        <div className="p-4 bg-slate-50 dark:bg-slate-800 rounded-lg">
          <p className="text-sm text-muted-foreground">
            💡 <span className="font-medium">Tip:</span> Check the URL and try again, or use the navigation below to find what you need.
          </p>
        </div>

        <div className="flex flex-col gap-3">
          <Link href="/" className="w-full">
            <Button className="w-full gap-2 bg-blue-600 hover:bg-blue-700">
              <Home className="h-4 w-4" />
              Go to Home
            </Button>
          </Link>

          <Link href="/login" className="w-full">
            <Button
              variant="outline"
              className="w-full gap-2"
            >
              <ArrowLeft className="h-4 w-4" />
              Back to Login
            </Button>
          </Link>

        </div>

        <div className="space-y-2 text-xs text-muted-foreground border-t pt-4">
          <p>Quick Links:</p>
          <div className="grid grid-cols-2 gap-2">
            <Link href="/login" className="text-blue-600 dark:text-blue-400 hover:underline">
              Login
            </Link>
            <Link href="/contact" className="text-blue-600 dark:text-blue-400 hover:underline">
              Contact Support
            </Link>
          </div>
        </div>
      </Card>
    </main>
  )
}
