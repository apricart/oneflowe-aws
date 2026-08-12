"use client"
import { useState } from "react"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"

function createAdjustmentItem() {
  return { key: crypto.randomUUID(), sku: "", name: "", quantity: 0, unit: "pcs" }
}

export default function AdjustInventoryPage() {
  const [form, setForm] = useState(() => ({ organizationId: "", branchId: "", note: "", items: [createAdjustmentItem()] }))
  const [saving, setSaving] = useState(false)
  function setItem(idx: number, field: string, value: any) {
    const items = [...form.items]
      ; (items[idx] as any)[field] = value
    setForm({ ...form, items })
  }
  async function onSave() {
    setSaving(true)
    try {
      const items = form.items.map((item) => ({
        sku: item.sku,
        name: item.name,
        quantity: item.quantity,
        unit: item.unit,
      }))
      const res = await fetch("/api/v1/inventory/transactions", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...form, items, type: "ADJUST" }) })
      if (!res.ok) throw new Error("Failed")
      alert("Inventory adjusted")
    } finally {
      setSaving(false)
    }
  }
  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Adjust Inventory</h1>
      <div className="grid gap-4 md:grid-cols-2">
        <div className="grid gap-1"><label htmlFor="adjust-organization-id" className="text-sm">Organization Id</label><Input id="adjust-organization-id" value={form.organizationId} onChange={(e) => setForm({ ...form, organizationId: e.target.value })} /></div>
        <div className="grid gap-1"><label htmlFor="adjust-branch-id" className="text-sm">Branch Id</label><Input id="adjust-branch-id" value={form.branchId} onChange={(e) => setForm({ ...form, branchId: e.target.value })} /></div>
      </div>
      <div className="grid gap-2">
        <div className="text-sm font-medium">Items</div>
        {form.items.map((it, i) => (
          <div key={it.key} className="grid gap-2 md:grid-cols-4">
            <Input placeholder="SKU" value={it.sku} onChange={(e) => setItem(i, "sku", e.target.value)} />
            <Input placeholder="Name" value={it.name} onChange={(e) => setItem(i, "name", e.target.value)} />
            <Input placeholder="Qty (+/-)" type="number" value={it.quantity} onChange={(e) => setItem(i, "quantity", Number(e.target.value))} />
            <Input placeholder="Unit" value={it.unit} onChange={(e) => setItem(i, "unit", e.target.value)} />
          </div>
        ))}
        <div>
          <Button variant="secondary" onClick={() => setForm({ ...form, items: [...form.items, createAdjustmentItem()] })}>Add Item</Button>
        </div>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" onClick={() => window.location.replace("/inventory")}>Back</Button>
        <Button onClick={onSave} disabled={saving}>{saving ? "Saving..." : "Save"}</Button>
      </div>
    </div>
  )
}

