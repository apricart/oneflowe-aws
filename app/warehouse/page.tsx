import { WarehouseWorkspace } from "@/components/warehouse/warehouse-workspace"

/**
 * Apricart's warehouse workspace. The role gate is the layout above; every
 * endpoint the workspace calls checks the role and the branch reach again.
 */
export default function WarehousePage() {
  return <WarehouseWorkspace />
}
