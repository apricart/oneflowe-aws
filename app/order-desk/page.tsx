import { OrderDeskWorkspace } from "@/components/order-desk/order-desk-workspace"

/**
 * Apricart's Order Desk. The role gate is the layout above; every endpoint the
 * workspace calls checks the role and the desk user's reach again on its own.
 */
export default function OrderDeskPage() {
  return <OrderDeskWorkspace />
}
