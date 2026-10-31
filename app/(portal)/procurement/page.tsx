import { ProcurementWorkspace } from "@/components/procurement/procurement-workspace"

/**
 * Buying for Apricart's warehouses. The role gate is the layout above; every
 * endpoint the page calls checks the capability again.
 * See plans/OF-PROCUREMENT-purchasing.md.
 */
export default function ProcurementPage() {
  return <ProcurementWorkspace />
}
