"use client"

import { useEffect, useState } from "react"

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
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import {
  MAX_DELIVERY_ADDRESS_CITY,
  MAX_DELIVERY_ADDRESS_CONTACT_PERSON,
  MAX_DELIVERY_ADDRESS_CONTACT_PHONE,
  MAX_DELIVERY_ADDRESS_LABEL,
  MAX_DELIVERY_ADDRESS_LINE,
  MAX_DELIVERY_ADDRESS_PROVINCE,
  MAX_DELIVERY_ADDRESS_REASON,
} from "@/lib/delivery-address"
import { jsonFetcher } from "@/lib/fetcher"

/**
 * Asking for an extra delivery address at a branch.
 *
 * Nothing here decides anything: whatever is submitted arrives as a pending
 * request and Head Office approves it before it can be delivered to. The form
 * says so, because a requester who thinks they have just added an address will
 * go looking for it at checkout.
 *
 * The branch options come from the list endpoint, which resolves them from the
 * session — this dialog never assembles a branch list of its own, and the
 * endpoint re-checks the chosen branch against the same resolved set anyway.
 */
export type RequestableBranch = { id: number; name: string }

const EMPTY_FORM = {
  label: "",
  address: "",
  city: "",
  province: "",
  contactPerson: "",
  contactPhone: "",
  reason: "",
}

export function DeliveryAddressRequestDialog({
  open,
  branches,
  onOpenChange,
  onRequested,
}: Readonly<{
  open: boolean
  branches: RequestableBranch[]
  onOpenChange: (open: boolean) => void
  onRequested: () => void
}>) {
  const [branchId, setBranchId] = useState<string>("")
  const [form, setForm] = useState(EMPTY_FORM)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setForm(EMPTY_FORM)
    setFailure(null)
    setBusy(false)
    // Preselected when there is only one branch to choose, which is every
    // single-branch requester.
    setBranchId(branches.length === 1 ? String(branches[0].id) : "")
  }, [open, branches])

  const update = (field: keyof typeof EMPTY_FORM) =>
    (event: { target: { value: string } }) =>
      setForm((current) => ({ ...current, [field]: event.target.value }))

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return

    const chosenBranch = Number.parseInt(branchId, 10)
    if (!Number.isSafeInteger(chosenBranch) || chosenBranch <= 0) {
      setFailure("Choose the branch this address belongs to.")
      return
    }

    setFailure(null)
    setBusy(true)
    try {
      await jsonFetcher("/api/v1/delivery-addresses", {
        method: "POST",
        body: JSON.stringify({
          branchId: chosenBranch,
          label: form.label.trim(),
          address: form.address.trim(),
          city: form.city.trim() || null,
          province: form.province.trim() || null,
          contactPerson: form.contactPerson.trim() || null,
          contactPhone: form.contactPhone.trim() || null,
          reason: form.reason.trim() || null,
        }),
      })
      onRequested()
      onOpenChange(false)
    } catch (caughtError: any) {
      setFailure(caughtError?.message || "The request could not be sent. Please try again.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next) }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <form onSubmit={submit} className="space-y-4">
          <DialogHeader>
            <DialogTitle>Request a delivery address</DialogTitle>
            <DialogDescription>
              Head Office has to approve this before orders can be sent there. Until then it stays
              on your list as waiting.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="delivery-address-branch">Branch</Label>
            <Select value={branchId} onValueChange={setBranchId} disabled={branches.length <= 1}>
              <SelectTrigger id="delivery-address-branch">
                <SelectValue placeholder="Choose a branch" />
              </SelectTrigger>
              <SelectContent>
                {branches.map((branch) => (
                  <SelectItem key={branch.id} value={String(branch.id)}>
                    {branch.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-address-label">Name for this address</Label>
            <Input
              id="delivery-address-label"
              required
              value={form.label}
              maxLength={MAX_DELIVERY_ADDRESS_LABEL}
              onChange={update("label")}
              placeholder="Warehouse Gate 2"
            />
            <p className="text-xs text-slate-500 dark:text-slate-400">
              What people will pick it by at checkout. It has to be different from the branch&apos;s
              other addresses.
            </p>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-address-line">Address</Label>
            <Textarea
              id="delivery-address-line"
              required
              value={form.address}
              maxLength={MAX_DELIVERY_ADDRESS_LINE}
              onChange={update("address")}
              rows={2}
              placeholder="Plot 14, Sector 23, Korangi Industrial Area"
            />
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="delivery-address-city">City</Label>
              <Input
                id="delivery-address-city"
                value={form.city}
                maxLength={MAX_DELIVERY_ADDRESS_CITY}
                onChange={update("city")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="delivery-address-province">Province</Label>
              <Input
                id="delivery-address-province"
                value={form.province}
                maxLength={MAX_DELIVERY_ADDRESS_PROVINCE}
                onChange={update("province")}
              />
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="delivery-address-contact">Contact person</Label>
              <Input
                id="delivery-address-contact"
                value={form.contactPerson}
                maxLength={MAX_DELIVERY_ADDRESS_CONTACT_PERSON}
                onChange={update("contactPerson")}
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="delivery-address-phone">Contact phone</Label>
              <Input
                id="delivery-address-phone"
                value={form.contactPhone}
                maxLength={MAX_DELIVERY_ADDRESS_CONTACT_PHONE}
                onChange={update("contactPhone")}
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="delivery-address-reason">Why is it needed? (optional)</Label>
            <Textarea
              id="delivery-address-reason"
              value={form.reason}
              maxLength={MAX_DELIVERY_ADDRESS_REASON}
              onChange={update("reason")}
              rows={3}
              placeholder="Shown to Head Office when they review this."
            />
          </div>

          {failure && (
            <p role="alert" className="text-sm text-red-600 dark:text-red-400">
              {failure}
            </p>
          )}

          <DialogFooter className="gap-2 sm:gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() => onOpenChange(false)}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
              Send for approval
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
