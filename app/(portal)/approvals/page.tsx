import { ApprovalsWorkspace } from "@/components/group-portal/approvals-workspace"

/**
 * The Group User's approval queue, rendered inside the shared portal shell so
 * the role gets the same sidebar and topbar every other portal role has.
 *
 * Reachable only by GROUP_USER: the proxy keeps this area exclusive to it, the
 * server layout above refuses any other role before this page renders, and
 * every endpoint it calls allowlists the role independently.
 */
export default function ApprovalsPage() {
  return <ApprovalsWorkspace />
}
