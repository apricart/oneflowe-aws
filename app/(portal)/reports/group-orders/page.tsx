import { GroupOrderReport } from "@/components/group-portal/group-order-report"

/**
 * The Group User's group order report, rendered inside the shared portal shell
 * so the role keeps the same sidebar and topbar as every other portal page.
 *
 * Reachable only by GROUP_USER: the server layout above refuses any other role
 * before this page renders, and the endpoint it calls allowlists the role
 * independently.
 */
export default function GroupOrderReportPage() {
  return <GroupOrderReport />
}
