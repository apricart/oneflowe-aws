"use client"

import { useState,useEffect } from "react"
import { Card,CardContent,CardDescription,CardHeader,CardTitle } from "@/components/ui/card"
import { Switch } from "@/components/ui/switch"
import { useToast } from "@/hooks/use-toast"
import { handleError } from "@/lib/error-handler"
import { jsonFetcher } from "@/lib/fetcher"
import { MFAVerificationDialog } from "./mfa-verification-dialog"
import { Shield,ShieldCheck,ShieldOff,AlertTriangle,CheckCircle } from "lucide-react"

interface MFASettingsProps {
  username?: string
}

export function MFASettings({ username }: Readonly<MFASettingsProps>) {
  const [mfaEnabled, setMfaEnabled] = useState(false)
  const [isLoading, setIsLoading] = useState(true)
  const [isToggling, setIsToggling] = useState(false)
  const [showVerification, setShowVerification] = useState(false)
  const [pendingAction, setPendingAction] = useState<'enable' | 'disable' | null>(null)
  const { toast } = useToast()

  // Load MFA status
  useEffect(() => {
    loadMFAStatus()
  }, [])

  const loadMFAStatus = async () => {
    try {
      const response = await jsonFetcher<any>("/api/v1/mfa/status")
      if (response.error) {
        throw new Error(response.error)
      }
      setMfaEnabled(response.mfaEnabled)
    } catch (error: any) {
      const { message } = handleError(error, "load MFA status")
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      })
    } finally {
      setIsLoading(false)
    }
  }

  const applyMfaAction = async (action: 'enable' | 'disable', otpCode?: string) => {
    console.log("MFA Settings - Verification success:", {
      action,
      otpCode: otpCode ? "***" : "undefined",
      otpCodeType: typeof otpCode,
      otpCodeLength: otpCode ? otpCode.length : 0
    })

    setIsToggling(true)
    try {
      const response = await jsonFetcher<any>("/api/v1/mfa/toggle", {
        method: "POST",
        body: JSON.stringify({ action, otpCode })
      })

      if (response.error) {
        throw new Error(response.error)
      }

      setMfaEnabled(response.mfaEnabled)
      toast({
        title: "Success",
        description: response.message,
        variant: "default",
      })

    } catch (error: any) {
      const { message } = handleError(error, "toggle MFA")
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      })
    } finally {
      setIsToggling(false)
      setShowVerification(false)
      setPendingAction(null)
    }
  }

  const enableMfa = () => {
    setPendingAction('enable')
    void applyMfaAction('enable')
  }

  const disableMfa = () => {
    setPendingAction('disable')
    void applyMfaAction('disable')
  }

  const handleVerificationSuccess = async (otpCode?: string) => {
    if (pendingAction) {
      await applyMfaAction(pendingAction, otpCode)
    }
  }

  if (isLoading) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Multi-Factor Authentication
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="flex items-center justify-center py-8">
            <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-blue-600"></div>
          </div>
        </CardContent>
      </Card>
    )
  }

  return (
    <>
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Multi-Factor Authentication
          </CardTitle>
          <CardDescription>
            Add an extra layer of security to your account with OTP verification
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* MFA Status */}
          <div className="flex items-center justify-between">
            <div className="space-y-1">
              <div className="flex items-center gap-2">
                {mfaEnabled ? (
                  <>
                    <ShieldCheck className="h-4 w-4 text-green-600" />
                    <span className="font-medium text-green-700">MFA Enabled</span>
                  </>
                ) : (
                  <>
                    <ShieldOff className="h-4 w-4 text-gray-400" />
                    <span className="font-medium text-gray-600">MFA Disabled</span>
                  </>
                )}
              </div>
              <p className="text-sm text-muted-foreground">
                {mfaEnabled
                  ? "Your account is protected with OTP verification"
                  : "Enable MFA to secure your account with OTP verification"
                }
              </p>
            </div>
            <Switch
              checked={mfaEnabled}
              onCheckedChange={mfaEnabled ? disableMfa : enableMfa}
              disabled={isToggling}
            />
          </div>

          {/* Security Benefits */}
          <div className="space-y-3">
            <h4 className="font-medium text-sm">Security Benefits:</h4>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 text-green-600" />
                <span>Protects against unauthorized access</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 text-green-600" />
                <span>OTP codes expire after 2 minutes</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 text-green-600" />
                <span>Rate limiting prevents abuse</span>
              </div>
              <div className="flex items-center gap-2">
                <CheckCircle className="h-3 w-3 text-green-600" />
                <span>Codes sent to your registered email</span>
              </div>
            </div>
          </div>

          {/* Warning */}
          {!mfaEnabled && (
            <div className="flex items-start gap-2 p-3 bg-amber-50 border border-amber-200 rounded-md">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5" />
              <div className="text-sm text-amber-700">
                <p className="font-medium">Security Recommendation</p>
                <p>Enable MFA to protect your account from unauthorized access. This adds an extra layer of security by requiring a verification code sent to your email.</p>
              </div>
            </div>
          )}

          {/* Current Status Info */}
          {mfaEnabled && (
            <div className="flex items-start gap-2 p-3 bg-green-50 border border-green-200 rounded-md">
              <ShieldCheck className="h-4 w-4 text-green-600 mt-0.5" />
              <div className="text-sm text-green-700">
                <p className="font-medium">MFA is Active</p>
                <p>Your account is protected. You'll receive OTP codes via email when logging in or performing sensitive actions.</p>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Verification Dialog */}
      <MFAVerificationDialog
        open={showVerification}
        onClose={() => {
          setShowVerification(false)
          setPendingAction(null)
        }}
        onSuccess={handleVerificationSuccess}
        type="LOGIN"
        username={username}
      />
    </>
  )
}
