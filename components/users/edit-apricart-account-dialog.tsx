"use client"

import { useState } from "react"
import { Loader2 } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/hooks/use-toast"
import {
  ACCOUNT_PASSWORD_MIN_LENGTH,
  accountFieldsFrom,
  buildAccountPatch,
  type AccountFields,
  type AccountRecord,
} from "@/lib/apricart-account-edit"

export type EditableApricartAccount = AccountRecord & { id: string; fullName: string | null }

const FIELDS: Array<{ key: keyof AccountFields; label: string; type: string; autoComplete: string }> = [
  { key: "firstName", label: "First name", type: "text", autoComplete: "off" },
  { key: "lastName", label: "Last name", type: "text", autoComplete: "off" },
  { key: "email", label: "Email", type: "email", autoComplete: "off" },
  { key: "username", label: "Username", type: "text", autoComplete: "off" },
  { key: "phone", label: "Phone (optional)", type: "tel", autoComplete: "off" },
]

/**
 * Super Admin edits an Order Desk or warehouse account from its team page, and
 * may set a new password for it. It uses the shared user route, which checks
 * the caller again and signs the account out everywhere when the password
 * changes. Role, reach and status are not edited here.
 */
export function EditApricartAccountDialog({
  account,
  noun,
  onClose,
  onSaved,
}: Readonly<{
  account: EditableApricartAccount
  /** What the account is called on this page, e.g. "desk user". */
  noun: string
  onClose: () => void
  onSaved: () => void
}>) {
  const [initial] = useState(() => accountFieldsFrom(account))
  const [form, setForm] = useState(initial)
  const [settingPassword, setSettingPassword] = useState(false)
  const [password, setPassword] = useState("")
  const [confirmation, setConfirmation] = useState("")
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  const save = async () => {
    if (saving) return
    const built = buildAccountPatch(initial, form, settingPassword ? { password, confirmation } : null)
    if (!built.ok) {
      setFormError(built.error)
      return
    }
    setSaving(true)
    setFormError(null)
    try {
      const response = await fetch(`/api/v1/users/${encodeURIComponent(account.id)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(built.patch),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        setFormError(typeof data?.error === "string" ? data.error : `The ${noun} could not be saved`)
        return
      }
      toast({
        title: built.patch.password ? "Saved, with a new password" : "Saved",
        description: built.patch.password
          ? "They have been signed out and sign in again with the new password."
          : account.fullName ?? account.email,
      })
      onSaved()
      onClose()
    } catch {
      setFormError("The request could not be sent. Check the connection and try again.")
    } finally {
      setSaving(false)
    }
  }

  const togglePassword = () => {
    setSettingPassword((current) => !current)
    setPassword("")
    setConfirmation("")
    setFormError(null)
  }

  return (
    <Dialog open onOpenChange={(next) => { if (!next && !saving) onClose() }}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Edit {account.fullName ?? account.email}</DialogTitle>
          <DialogDescription>
            Change this {noun}&apos;s details or set a new password. They sign in with the username or email shown here.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => { event.preventDefault(); void save() }}
        >
          <div className="grid gap-3 sm:grid-cols-2">
            {FIELDS.map(({ key, label, type, autoComplete }) => (
              <div key={key} className="space-y-1">
                <Label htmlFor={`apricart-account-${key}`}>{label}</Label>
                <Input
                  id={`apricart-account-${key}`}
                  type={type}
                  autoComplete={autoComplete}
                  value={form[key]}
                  disabled={saving}
                  onChange={(event) => setForm((current) => ({ ...current, [key]: event.target.value }))}
                />
              </div>
            ))}
          </div>

          <div className="space-y-3 rounded-md border p-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium">Password</p>
                <p className="text-xs text-muted-foreground">Setting a new one signs them out on every device.</p>
              </div>
              <Button type="button" size="sm" variant="outline" onClick={togglePassword} disabled={saving}>
                {settingPassword ? "Keep current password" : "Set new password"}
              </Button>
            </div>
            {settingPassword && (
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="apricart-account-password">New password</Label>
                  <Input
                    id="apricart-account-password"
                    type="password"
                    autoComplete="new-password"
                    value={password}
                    disabled={saving}
                    onChange={(event) => setPassword(event.target.value)}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="apricart-account-confirmation">Confirm new password</Label>
                  <Input
                    id="apricart-account-confirmation"
                    type="password"
                    autoComplete="new-password"
                    value={confirmation}
                    disabled={saving}
                    onChange={(event) => setConfirmation(event.target.value)}
                  />
                </div>
                <p className="text-xs text-muted-foreground sm:col-span-2">
                  At least {ACCOUNT_PASSWORD_MIN_LENGTH} characters with upper and lower case letters, a number and a symbol.
                </p>
              </div>
            )}
          </div>

          {formError && <p role="alert" className="text-sm text-destructive">{formError}</p>}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={saving}>Cancel</Button>
            <Button type="submit" disabled={saving}>
              {saving && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
