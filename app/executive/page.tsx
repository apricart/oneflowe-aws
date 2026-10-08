import { ExecutiveWorkspace } from "@/components/delivery-dashboard/executive-workspace"

/**
 * Apricart management's delivery dashboard. The role gate is the layout above;
 * both endpoints the dashboard calls check the role again on their own.
 */
export default function ExecutivePage() {
  return <ExecutiveWorkspace />
}
