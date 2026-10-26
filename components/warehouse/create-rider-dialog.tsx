"use client"

import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"

import { PakistanCityCombobox } from "@/components/join/pakistan-city-combobox"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { toast } from "@/hooks/use-toast"
import type { PakistanCity } from "@/lib/pakistan-cities"

type Props = {
  open: boolean
  onClose: () => void
  onCreated: () => void
}

type FormState = {
  code: string
  fullName: string
  email: string
  password: string
  phone: string
  vehicleNumber: string
  city: string
}

const EMPTY: FormState = {
  code: "",
  fullName: "",
  email: "",
  password: "",
  phone: "",
  vehicleNumber: "",
  city: "",
}

/**
 * Warehouse creates a rider bound to a Pakistan city. That city pins the rider
 * to this warehouse's depot (Karachi uses the known warehouse start coords).
 */
export function CreateRiderDialog({ open, onClose, onCreated }: Props) {
  const [form, setForm] = useState<FormState>(EMPTY)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!open) return
    setForm(EMPTY)
  }, [open])

  const setField = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }))
  }

  const submit = async () => {
    if (!form.code.trim() || !form.fullName.trim() || !form.email.trim() || !form.password || !form.city) {
      toast({ title: "Fill every required field, including city", variant: "destructive" })
      return
    }
    if (form.password.length < 12) {
      toast({ title: "Password must be at least 12 characters", variant: "destructive" })
      return
    }

    setSubmitting(true)
    try {
      const response = await fetch("/api/v1/rider-ops/riders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          code: form.code.trim(),
          fullName: form.fullName.trim(),
          email: form.email.trim(),
          password: form.password,
          phone: form.phone.trim() || null,
          vehicleNumber: form.vehicleNumber.trim() || null,
          city: form.city,
        }),
      })
      const body = (await response.json().catch(() => null)) as { error?: string; city?: string } | null
      if (!response.ok) {
        toast({
          title: body?.error ?? "Could not create rider",
          variant: "destructive",
        })
        return
      }
      toast({ title: "Rider created" })
      onCreated()
      onClose()
    } catch {
      toast({ title: "Could not create rider", variant: "destructive" })
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create rider</DialogTitle>
        </DialogHeader>

        <div className="grid gap-4 py-2">
          <div className="grid gap-2">
            <Label htmlFor="rider-code">Code *</Label>
            <Input
              id="rider-code"
              value={form.code}
              onChange={(e) => setField("code", e.target.value)}
              placeholder="e.g. KHI-R01"
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rider-name">Full name *</Label>
            <Input
              id="rider-name"
              value={form.fullName}
              onChange={(e) => setField("fullName", e.target.value)}
              autoComplete="name"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rider-email">Email *</Label>
            <Input
              id="rider-email"
              type="email"
              value={form.email}
              onChange={(e) => setField("email", e.target.value)}
              autoComplete="off"
            />
          </div>
          <div className="grid gap-2">
            <Label htmlFor="rider-password">Password *</Label>
            <Input
              id="rider-password"
              type="password"
              value={form.password}
              onChange={(e) => setField("password", e.target.value)}
              autoComplete="new-password"
              placeholder="At least 12 characters"
            />
          </div>
          <div className="grid gap-2">
            <Label>City *</Label>
            <PakistanCityCombobox
              value={form.city}
              onSelect={(city: PakistanCity) => setField("city", city.name)}
              label="City"
            />
          </div>
          <div className="grid gap-2 sm:grid-cols-2 sm:gap-3">
            <div className="grid gap-2">
              <Label htmlFor="rider-phone">Phone</Label>
              <Input
                id="rider-phone"
                value={form.phone}
                onChange={(e) => setField("phone", e.target.value)}
                autoComplete="tel"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="rider-vehicle">Vehicle</Label>
              <Input
                id="rider-vehicle"
                value={form.vehicleNumber}
                onChange={(e) => setField("vehicleNumber", e.target.value)}
              />
            </div>
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
            Cancel
          </Button>
          <Button type="button" onClick={() => { void submit() }} disabled={submitting}>
            {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
            Create rider
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
