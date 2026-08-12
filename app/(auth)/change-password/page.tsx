"use client"
import { useState, useEffect } from "react"
import type React from "react"
import { useRouter } from "next/navigation"
import { signOut, useSession } from "next-auth/react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card"
import { Spinner } from "@/components/ui/skeleton"
import { useToast } from "@/hooks/use-toast"
import Image from "next/image"
import { Eye, EyeOff, ShieldAlert } from "lucide-react"

export default function ChangePasswordPage() {
  const router = useRouter()
  const { status } = useSession()
  const { toast } = useToast()
  const [newPassword, setNewPassword] = useState("")
  const [confirmPassword, setConfirmPassword] = useState("")
  const [showNew, setShowNew] = useState(false)
  const [showConfirm, setShowConfirm] = useState(false)
  const [loading, setLoading] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  // Redirect to login if unauthenticated. Middleware handles the mustChangePassword gate —
  // do NOT redirect to /shop or /dashboard here; doing so races with the JWT check in
  // middleware and causes an infinite redirect loop (change-password ↔ shop/dashboard).
  useEffect(() => {
    if (status === "loading") return
    if (status === "unauthenticated") {
      router.replace("/login")
    }
  }, [status, router])

  async function onSubmit(e: React.SubmitEvent<HTMLFormElement>) {
    e.preventDefault()
    setFormError(null)

    if (newPassword !== confirmPassword) {
      setFormError("Passwords do not match.")
      return
    }

    setLoading(true)
    try {
      const res = await fetch("/api/v1/users/me/change-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: newPassword }),
      })

      const data = await res.json()

      if (!res.ok) {
        setFormError(data?.error || "Failed to change password. Please try again.")
        return
      }

      toast({
        title: "Password changed",
        description: "Please sign in again with your new password.",
      })

      // Session is now invalid (sessionVersion bumped). Sign out cleanly.
      await signOut({ redirect: true, callbackUrl: "/login" })
    } catch {
      setFormError("An unexpected error occurred. Please try again.")
    } finally {
      setLoading(false)
    }
  }

  if (status === "loading") {
    return (
      <main className="min-h-[100svh] flex items-center justify-center">
        <Spinner size={32} />
      </main>
    )
  }

  return (
    <main className="min-h-[100svh] flex items-center justify-center relative overflow-hidden">
      {/* Background */}
      <div className="absolute inset-0 z-0">
        <Image
          src="/Background-Login.png"
          alt="Background"
          fill
          className="object-cover"
          priority
        />
        <div className="absolute inset-0 bg-black/40 backdrop-blur-[1px]" />
      </div>

      <div className="relative z-10 w-full max-w-md mx-4">
        <Card className="w-full border-0 shadow-2xl bg-white/95 backdrop-blur-sm">
          <CardHeader>
            <div className="flex items-center gap-3">
              <div
                className="bg-white rounded-lg p-2 flex items-center justify-center border-2 shadow-lg"
                style={{ borderColor: "var(--color-brand-primary)" }}
              >
                <Image src="/logo-pos.png" alt="Apricart" width={32} height={32} />
              </div>
              <CardTitle className="text-2xl font-semibold text-slate-800">
                Set New Password
              </CardTitle>
            </div>
          </CardHeader>

          <CardContent>
            {/* Informational banner */}
            <div className="mb-5 flex items-start gap-3 rounded-md border border-amber-200 bg-amber-50 p-3">
              <ShieldAlert className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
              <p className="text-sm text-amber-800 leading-relaxed">
                Your account requires a new password before you can continue. Please choose a strong password that you haven't used before.
              </p>
            </div>

            <form onSubmit={onSubmit} className="grid gap-4">
              {/* New password */}
              <div className="grid gap-2">
                <label htmlFor="newPassword" className="text-sm font-medium text-slate-700">
                  New Password
                </label>
                <div className="relative">
                  <Input
                    id="newPassword"
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={12}
                    placeholder="Min. 12 characters"
                    className="bg-white/80 border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNew(!showNew)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 focus:outline-none"
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Confirm password */}
              <div className="grid gap-2">
                <label htmlFor="confirmPassword" className="text-sm font-medium text-slate-700">
                  Confirm New Password
                </label>
                <div className="relative">
                  <Input
                    id="confirmPassword"
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    required
                    placeholder="Repeat your new password"
                    className="bg-white/80 border-slate-300 text-slate-900 placeholder:text-slate-400 focus:border-blue-500 focus:ring-blue-500 pr-10"
                  />
                  <button
                    type="button"
                    onClick={() => setShowConfirm(!showConfirm)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-500 hover:text-slate-700 focus:outline-none"
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>

              {/* Password requirements hint */}
              <p className="text-xs text-slate-500">
                Must be at least 12 characters and include uppercase, lowercase, a number, and a special character.
              </p>

              {/* Error message */}
              {formError && (
                <div className="p-3 bg-red-50 border border-red-200 rounded-md">
                  <p className="text-sm text-red-600 font-medium flex items-center gap-2">
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><line x1="12" x2="12" y1="8" y2="12" /><line x1="12" x2="12.01" y1="16" y2="16" /></svg>
                    {formError}
                  </p>
                </div>
              )}

              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-blue-600 hover:bg-blue-700 text-white font-medium shadow-lg"
              >
                {loading ? (
                  <span className="inline-flex items-center gap-2">
                    <Spinner size={16} /> Saving…
                  </span>
                ) : (
                  "Set New Password"
                )}
              </Button>
            </form>
          </CardContent>
        </Card>
      </div>
    </main>
  )
}
