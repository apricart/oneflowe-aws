import { GroupStorefront } from "@/components/group-portal/storefront/group-storefront"

/**
 * The requester's storefront: the side menu of assigned groups and locations,
 * and the catalogue for whichever of them is selected.
 *
 * The role gate lives in the layout above, which refuses every role but
 * GROUP_ORDER_PORTAL before this page renders. Every endpoint the storefront
 * calls allowlists that role again on its own.
 */
export default function GroupPortalPage() {
  return <GroupStorefront />
}
