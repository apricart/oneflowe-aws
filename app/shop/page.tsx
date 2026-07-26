"use client"
import React, { useMemo, useState } from "react"
import { formatPKR, cn } from "@/lib/utils"
import { calculateLineCents, formatQuantity, parseQuantity, roundQuantity, sanitizeQuantityStep } from "@/lib/quantity"
import useSWR from "swr"
import { useSession, signOut } from "next-auth/react"
import { useRouter } from "next/navigation"
import { useToast } from "@/hooks/use-toast"
import { useOrganizations, useBranches } from "@/lib/hooks/use-api"
import { useAppContext } from "@/components/context/app-context"
import { ContextSelector } from "@/components/shell/context-selector"
import { Card } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog"
import { ShoppingBag, Search, Plus, Minus, Trash2, Home, X, CheckCircle, Clock, AlertTriangle, DollarSign, Star, Zap, Package, TrendingDown, Grid, LogOut, ArrowRight, ArrowLeft, Calendar, MapPin, RefreshCw, Building2, Copy, Send } from "lucide-react"
import { Skeleton } from "@/components/ui/skeleton"
import Image from "next/image"
import { RefundManagement } from "@/components/refund-management"
import { getOrderDerivedStatus } from "@/lib/order-status"
import { ReceiptIconButton } from "@/components/receipts/receipt-icon-button"
import { NotificationBell } from "@/components/notifications/notification-center"

const ORDER_PORTAL_REFRESH_INTERVAL_MS = 5000

const fetcher = (url: string) => fetch(url, { cache: "no-store" }).then(r => r.json())

const parseProductRating = (rating: unknown) => {
  const numericRating = typeof rating === "number" ? rating : Number(rating)
  return Number.isFinite(numericRating) ? numericRating : 0
}

interface Product {
  id: number
  name: string
  code: string
  priceCents: number | null
  unit: string
  imageUrl?: string
  stock?: number
  allowDecimalQuantity?: boolean
  quantityStep?: number
  rating?: number
  description?: string
  discountType?: string | null
  discountValue?: number | null
  discountStartAt?: string | null
  discountEndAt?: string | null
  discountActive?: boolean
  quantityBudgetRemaining?: number | null
}

interface CartItem extends Product {
  quantity: number
}

interface Order {
  id: number
  tid: string
  status: string
  totalCents: number | null
  createdAt: string
  refundAmountCents?: number | null
  refundedAt?: string | null
  refundReason?: string | null
  rejectionReason?: string | null
  statusAtRefund?: string | null
  approvalToken?: string | null
  orderItems?: OrderItem[]
}

interface OrderItem {
  id: number
  quantity: number
  quantityRefunded?: number | null
}

type RefundState = "none" | "partial" | "full"

const getRefundState = (order: Pick<Order, "status" | "totalCents" | "refundAmountCents" | "orderItems">): RefundState => {
  if ((order.status || "").toLowerCase() === "refunded") return "full"

  if (order.orderItems?.length) {
    const refundedItems = order.orderItems.filter((item) => (item.quantityRefunded || 0) > 0)
    if (refundedItems.length === 0) return "none"

    const allItemsFullyRefunded = order.orderItems.every((item) => (item.quantityRefunded || 0) >= item.quantity)
    return allItemsFullyRefunded ? "full" : "partial"
  }

  const refundAmount = order.refundAmountCents || 0
  if (refundAmount <= 0) return "none"
  if (order.totalCents === null) return "partial"
  return refundAmount >= order.totalCents ? "full" : "partial"
}

const isRefundRelatedOrder = (order: Pick<Order, "status" | "totalCents" | "refundAmountCents" | "orderItems">) =>
  getRefundState(order) !== "none"

const isActiveOrder = (order: Pick<Order, "status" | "totalCents" | "refundAmountCents" | "orderItems">) =>
  getRefundState(order) === "none"

const getProductStep = (product: Pick<Product, "allowDecimalQuantity" | "quantityStep">) =>
  sanitizeQuantityStep(Boolean(product.allowDecimalQuantity), product.quantityStep ?? 1)

const clampProductQuantity = (product: Pick<Product, "stock" | "allowDecimalQuantity" | "quantityStep">, quantity: number) => {
  const maxStock = product.stock ?? 999
  if (product.allowDecimalQuantity) {
    return roundQuantity(Math.min(Math.max(roundQuantity(quantity), 0), maxStock))
  }
  const step = getProductStep(product)
  const minQuantity = step
  const clamped = Math.min(Math.max(roundQuantity(quantity), minQuantity), maxStock)
  const stepped = Math.round(clamped / step) * step
  return roundQuantity(Math.min(Math.max(stepped, minQuantity), maxStock))
}

export default function OrderPortalPage() {
  const { data: session, status } = useSession()
  const router = useRouter()
  const { toast } = useToast()
  const { branchId: contextBranchId, organizationId: contextOrgId } = useAppContext()

  const [searchQuery, setSearchQuery] = useState("")
  const [sortBy, setSortBy] = useState("name")
  const [cart, setCart] = useState<CartItem[]>([])
  const [showCart, setShowCart] = useState(false)
  const [showCheckout, setShowCheckout] = useState(false)
  const [selectedProduct, setSelectedProduct] = useState<Product | null>(null)
  const [showProductDetail, setShowProductDetail] = useState(false)
  const [tempQuantity, setTempQuantity] = useState(1)
  const [cardQuantities, setCardQuantities] = useState<Record<number, number>>({})
  const [activeTab, setActiveTab] = useState<"shop" | "orders" | "refunded">("shop")
  const [showOrderDetail, setShowOrderDetail] = useState(false)
  const [selectedOrder, setSelectedOrder] = useState<Order | null>(null)
  const [pageSize, setPageSize] = useState(12)
  const [currentPage, setCurrentPage] = useState(1)
  const [activeCategory, setActiveCategory] = useState<string>("All")
  const [isPlacingOrder, setIsPlacingOrder] = useState(false)
  const [isSendingTokenEmail, setIsSendingTokenEmail] = useState(false)
  const orderIdempotencyKeyRef = React.useRef<string | null>(null)
  const orderSubmissionInFlightRef = React.useRef(false)

  React.useEffect(() => {
    if (!orderSubmissionInFlightRef.current) {
      orderIdempotencyKeyRef.current = null
    }
  }, [cart])

  // Auth check
  React.useEffect(() => {
    if (status === "loading") {
      return
    }

    if (status === "unauthenticated") {
      window.location.replace("/login")
      return
    }

    if (status === "authenticated") {
      const userRole = (session?.user as any)?.role
      const isEmployee = (session?.user as any)?.isEmployee
      const isAdmin = userRole === "BRANCH_ADMIN" || userRole === "HEAD_OFFICE" || userRole === "SUPER_ADMIN"
      const isOrderPortal = userRole === "ORDER_PORTAL"

      // Allow admin users, employees, and order portal users
      if (isAdmin || isEmployee || isOrderPortal) {
        return // User is authorized, allow access
      }

      // Redirect unauthorized users
      window.location.replace("/")
    }
  }, [status, session, router])

  const userRole = (session?.user as any)?.role
  const isEmployee = (session?.user as any)?.isEmployee
  const isAdmin = userRole === "BRANCH_ADMIN" || userRole === "HEAD_OFFICE" || userRole === "SUPER_ADMIN"
  const isOrderPortal = userRole === "ORDER_PORTAL"
  const userName = (session?.user as any)?.fullName || (session?.user as any)?.email || "User"

  // Use context branch ID, fallback to session branch ID for BRANCH_ADMIN and employees
  const activeBranchId = contextBranchId ? parseInt(contextBranchId) : (session?.user as any)?.branchId
  const activeOrgId = contextOrgId ? parseInt(contextOrgId) : (session?.user as any)?.organizationId

  // Determine if we need to pass branchId/organizationId as query params
  // We need to pass them if:
  // 1. User is admin using context selector (no default branch in session)
  // 2. User is employee (always pass to ensure correct context)
  // 3. User is ORDER_PORTAL (similar to employee, ensure correct context)
  const needsContextParams = (isAdmin && !((session?.user as any)?.branchId)) || isEmployee || isOrderPortal

  // Build API URLs using context
  const branchInventoryUrl = activeBranchId
    ? `/api/v1/branch/inventory?visibility=visible&includeQuantityBudget=true${needsContextParams ? `&branchId=${activeBranchId}${activeOrgId ? `&organizationId=${activeOrgId}` : ""}` : ""}`
    : null
  const budgetsUrl = activeBranchId
    ? `/api/v1/budgets${needsContextParams ? `?branchId=${activeBranchId}${activeOrgId ? `&organizationId=${activeOrgId}` : ""}` : ""}`
    : null

  const { data: inventoryData, mutate: mutateBranchInventory, error: inventoryError } = useSWR<any>(branchInventoryUrl, fetcher, {
    refreshInterval: ORDER_PORTAL_REFRESH_INTERVAL_MS, // Auto-refresh so admin changes appear quickly
  })
  const { data: budget, mutate: mutateBudget } = useSWR<any>(budgetsUrl, fetcher, {
    refreshInterval: ORDER_PORTAL_REFRESH_INTERVAL_MS,
  })
  const ordersUrl = "/api/v1/orders"
  const isViewingOrders = activeTab === "orders" || activeTab === "refunded"
  const { data: ordersData, mutate: mutateOrders } = useSWR<any>(ordersUrl, fetcher, {
    refreshInterval: isViewingOrders || showOrderDetail ? ORDER_PORTAL_REFRESH_INTERVAL_MS : 0,
    revalidateOnFocus: true,
    revalidateOnReconnect: true,
  })

  const handleTabChange = async (tab: "shop" | "orders" | "refunded") => {
    setActiveTab(tab)

    if (tab === "orders" || tab === "refunded") {
      const freshOrders = await fetcher(`${ordersUrl}?refresh=${Date.now()}`)
      await mutateOrders(freshOrders, { revalidate: false })
      void mutateBudget()
    }
  }

  const copyFulfillmentToken = async () => {
    const token = selectedOrder?.approvalToken
    if (!token) return

    try {
      await navigator.clipboard.writeText(token)
      toast({
        title: "Copied",
        description: "Fulfillment token copied to clipboard.",
      })
    } catch {
      toast({
        title: "Copy failed",
        description: "Could not copy the fulfillment token. Please select and copy it manually.",
        variant: "destructive",
      })
    }
  }

  const sendFulfillmentToken = async () => {
    if (!selectedOrder?.approvalToken) return

    setIsSendingTokenEmail(true)
    try {
      const response = await fetch(`/api/v1/orders/${selectedOrder.id}/send-token-email`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      })
      const responseText = await response.text()
      const data = responseText
        ? (() => {
            try {
              return JSON.parse(responseText)
            } catch {
              return { error: responseText }
            }
          })()
        : {}

      if (!response.ok) throw new Error(data.error || "Failed to send token email")

      toast({
        title: "Token sent",
        description: "Fulfillment token emailed to the admin.",
      })
    } catch (error) {
      toast({
        title: "Email failed",
        description: error instanceof Error ? error.message : "Failed to send token email",
        variant: "destructive",
      })
    } finally {
      setIsSendingTokenEmail(false)
    }
  }

  // Fetch full details for selected order to get items
  const { data: orderDetailsData } = useSWR(
    selectedOrder ? `/api/v1/orders?id=${selectedOrder.id}` : null,
    fetcher,
    {
      refreshInterval: showOrderDetail ? ORDER_PORTAL_REFRESH_INTERVAL_MS : 0,
      revalidateOnFocus: true,
      revalidateOnReconnect: true,
    }
  )
  const pricesHidden = Boolean(inventoryData?.pricesHidden || ordersData?.pricesHidden || orderDetailsData?.pricesHidden)
  const budgetVisible = Boolean(budget && !budget.pricesHidden)

  React.useEffect(() => {
    const freshOrder = orderDetailsData?.items?.[0]
    if (!freshOrder || !selectedOrder || freshOrder.id !== selectedOrder.id) return

    setSelectedOrder((current) => (
      current?.id === freshOrder.id
        ? { ...current, ...freshOrder }
        : current
    ))

    void mutateOrders((current: any) => {
      if (!current?.items) return current

      return {
        ...current,
        items: current.items.map((order: Order) => (
          order.id === freshOrder.id
            ? { ...order, ...freshOrder }
            : order
        )),
      }
    }, { revalidate: false })
  }, [orderDetailsData, selectedOrder?.id, mutateOrders])

  // Fetch names for header context
  const { data: orgsData } = useOrganizations()
  const { data: branchesData } = useBranches(activeOrgId?.toString())

  const activeOrgName = useMemo(() => {
    return orgsData?.items?.find((o: any) => o.id === activeOrgId)?.name || "Loading..."
  }, [orgsData, activeOrgId])

  const activeBranchName = useMemo(() => {
    return branchesData?.items?.find((b: any) => b.id === activeBranchId)?.name || "Loading..."
  }, [branchesData, activeBranchId])

  const shopInventoryItems = useMemo(() => {
    const items = inventoryData?.items || []
    if (!inventoryData?.quantityBudgetCatalogActive) return items

    return items.filter((item: any) => typeof item.quantityBudgetRemaining === "number")
  }, [inventoryData])

  const categories = useMemo(() => {
    if (shopInventoryItems.length === 0) return ["All"]
    const cats = new Set<string>()
    cats.add("All")
    shopInventoryItems.forEach((item: any) => {
      if (item.categoryName) cats.add(item.categoryName)
    })
    return Array.from(cats)
  }, [shopInventoryItems])

  const mappedProducts = useMemo(() => {
    return shopInventoryItems.map((item: any) => ({
      id: item.organizationInventoryId,
      name: item.customName || item.productName,
      code: item.productCode,
      priceCents: item.customPrice ?? item.basePrice ?? null,
      unit: item.unit,
      imageUrl: item.productImageUrl,
      stock: item.stockQuantity,
      allowDecimalQuantity: !!item.allowDecimalQuantity,
      quantityStep: typeof item.quantityStep === "number" ? item.quantityStep : undefined,
      rating: parseProductRating(item.rating),
      description: item.customDescription || item.productDescription,
      discountType: item.discountType,
      discountValue: item.discountValue,
      discountStartAt: item.discountStartAt,
      discountEndAt: item.discountEndAt,
      discountActive: item.discountActive,
      quantityBudgetRemaining: typeof item.quantityBudgetRemaining === "number"
        ? item.quantityBudgetRemaining
        : null,
    }))
  }, [shopInventoryItems])

  const products: Product[] = mappedProducts
  const productsById = useMemo(() => new Map(products.map((product) => [product.id, product])), [products])

  const filteredProducts = useMemo(() => {
    let filtered = [...products]
    if (searchQuery) {
      filtered = filtered.filter(p =>
        p.name.toLowerCase().includes(searchQuery.toLowerCase()) ||
        p.code.toLowerCase().includes(searchQuery.toLowerCase())
      )
    }

    if (activeCategory !== "All") {
      filtered = filtered.filter(p => {
        const item = shopInventoryItems.find((i: any) => i.organizationInventoryId === p.id)
        return item?.categoryName === activeCategory
      })
    }

    if (!pricesHidden && sortBy === "price-low") filtered.sort((a, b) => (a.priceCents || 0) - (b.priceCents || 0))
    else if (!pricesHidden && sortBy === "price-high") filtered.sort((a, b) => (b.priceCents || 0) - (a.priceCents || 0))
    else if (sortBy === "rating") filtered.sort((a, b) => (b.rating || 0) - (a.rating || 0))
    else filtered.sort((a, b) => a.name.localeCompare(b.name))
    return filtered
  }, [products, searchQuery, sortBy, activeCategory, shopInventoryItems, pricesHidden])

  // Reset to first page when filters change
  React.useEffect(() => {
    setCurrentPage(1)
  }, [searchQuery, sortBy, activeCategory])

  const totalProducts = filteredProducts.length
  const totalPages = Math.max(1, Math.ceil(totalProducts / pageSize))

  // Keep current page in range if product count changes
  React.useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const paginatedProducts = useMemo(() => {
    const start = (currentPage - 1) * pageSize
    const end = start + pageSize
    return filteredProducts.slice(start, end)
  }, [filteredProducts, currentPage, pageSize])

  const cartTotal = pricesHidden ? 0 : cart.reduce((sum, item) => sum + calculateLineCents(item.priceCents || 0, item.quantity), 0)
  const remainingBudget = budget?.remainingCents || 0
  const totalBudgetLimit = (budget?.amountAllocatedCents || 0) + (budget?.amountCreditedCents || 0)
  const canCheckout = pricesHidden ? cart.length > 0 : cartTotal <= remainingBudget && cart.length > 0
  const rawBudgetPercent = ((((totalBudgetLimit || 0) - remainingBudget) / (totalBudgetLimit || 1)) * 100)
  const budgetPercent = Math.min(100, Math.max(0, rawBudgetPercent || 0))
  const isLoadingInventory = !inventoryData && !inventoryError
  const showQuantityRemainingBadge = isOrderPortal && Boolean(inventoryData?.quantityBudgetCatalogActive)

  const openProductDetail = (product: Product) => {
    setSelectedProduct(product)
    setTempQuantity(product.allowDecimalQuantity ? 1 : getProductStep(product))
    setShowProductDetail(true)
  }

  const addToCartFromDetail = () => {
    if (selectedProduct && tempQuantity > 0) {
      addToCart(selectedProduct, tempQuantity)
      setShowProductDetail(false)
    }
  }

  const addToCart = (product: Product, qty: number = 1) => {
    const availableStock = product.stock || 0
    if (availableStock === 0) {
      toast({
        title: "Out of stock",
        description: `${product.name} is currently out of stock.`,
        variant: "destructive"
      })
      return
    }

    const normalizedQty = clampProductQuantity(product, qty)

    setCart(prev => {
      const existing = prev.find(item => item.id === product.id)
      const currentQtyInCart = existing?.quantity || 0
      const newTotalQty = roundQuantity(currentQtyInCart + normalizedQty)

      if (newTotalQty > availableStock) {
        toast({
          title: "Insufficient stock",
          description: isOrderPortal
            ? `${product.name} is not available in the requested quantity.`
            : `Only ${availableStock} available for ${product.name}. You already have ${currentQtyInCart} in cart.`,
          variant: "destructive"
        })
        return prev
      }

      toast({ title: `${product.name} added to cart` })
      if (existing) {
        return prev.map(item =>
          item.id === product.id ? { ...item, quantity: newTotalQty } : item
        )
      }
      return [...prev, { ...product, quantity: qty }]
    })
  }

  const updateQty = (id: number, qty: number) => {
    if (qty <= 0) {
      removeFromCart(id)
    } else {
      const itemInCart = cart.find(i => i.id === id)
      if (!itemInCart) return

      const normalizedQty = clampProductQuantity(itemInCart, qty)
      const availableStock = itemInCart.stock || 0
      if (normalizedQty > availableStock) {
        toast({
          title: "Insufficient stock",
          description: isOrderPortal
            ? `${itemInCart.name} is not available in the requested quantity.`
            : `Only ${availableStock} available for ${itemInCart.name}.`,
          variant: "destructive"
        })
        // If qty exceeds stock, cap it to available stock
        setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: availableStock } : i))
        return
      }

      setCart(prev => prev.map(i => i.id === id ? { ...i, quantity: normalizedQty } : i))
    }
  }

  const removeFromCart = (id: number) => {
    setCart(prev => prev.filter(item => item.id !== id))
  }

  const placeOrder = async () => {
    if (!canCheckout || orderSubmissionInFlightRef.current) return
    orderSubmissionInFlightRef.current = true
    setIsPlacingOrder(true)
    const idempotencyKey = orderIdempotencyKeyRef.current || crypto.randomUUID()
    orderIdempotencyKeyRef.current = idempotencyKey
    try {
      const res = await fetch("/api/v1/orders", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify({
          items: cart.map(c => ({ organizationInventoryId: c.id, quantity: c.quantity })),
          ...(isAdmin && activeBranchId && { branchId: activeBranchId, organizationId: activeOrgId }),
        })
      })
      const json = await res.json()
      if (!res.ok) {
        orderIdempotencyKeyRef.current = null
        if (json.error?.toLowerCase().includes("stock") || json.error?.toLowerCase().includes("budget")) {
          mutateBranchInventory()
          mutateBudget()
        }
        const description = pricesHidden && budgetVisible && json.error?.toLowerCase().includes("insufficient budget")
          ? `This order exceeds your remaining budget of PKR ${(remainingBudget / 100).toFixed(2)}. Please reduce quantities or contact head office.`
          : json.error
        return toast({ title: "Failed", description, variant: "destructive" })
      }

      toast({
        title: "Order Submitted",
        description: `TID: ${json.order?.tid}. Your order is now pending approval by the branch admin.`,
      })
      setCart([])
      orderIdempotencyKeyRef.current = null
      setShowCheckout(false)

      // Revalidate all data so UI updates immediately without refresh
      mutateOrders()
      mutateBudget() // Update budget display (remaining, on hold amounts)
      mutateBranchInventory() // Update stock quantities
    } catch (e: any) {
      toast({ title: "Error", description: e.message, variant: "destructive" })
    } finally {
      orderSubmissionInFlightRef.current = false
      setIsPlacingOrder(false)
    }
  }

  // Show loading only if truly loading AND not yet authenticated
  // If status is loading but we'll eventually be authenticated, don't block the UI
  if (status === "loading") {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-50/90 to-white/95 dark:from-slate-950 dark:to-slate-900">
        <div className="text-center space-y-3">
          <div
            className="inline-flex h-12 w-12 items-center justify-center rounded-2xl shadow-lg"
            style={{
              background:
                "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 40%), transparent 60%), var(--color-brand-primary)",
            }}
          >
            <ShoppingBag className="h-6 w-6 text-white animate-pulse" />
          </div>
          <p className="text-sm font-medium text-foreground/80">Loading Order Portal…</p>
        </div>
      </div>
    )
  }

  // If not authenticated, redirect happens in useEffect
  if (status === "unauthenticated") {
    return null // useEffect will handle redirect
  }

  // If still no user data despite being authenticated, show loading
  if (!session?.user) {
    return null
  }

  return (
    <div className="min-h-screen relative overflow-hidden bg-slate-50 dark:bg-slate-950">
      {/* Branded background layer */}
      <div
        className="pointer-events-none absolute inset-0 -z-10 dark:hidden"
        style={{
          backgroundImage:
            "radial-gradient(48rem 48rem at 0% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 75%), transparent 60%), radial-gradient(48rem 48rem at 100% 0%, color-mix(in oklab, var(--color-primary), transparent 78%), transparent 60%)",
          backgroundColor: "oklch(0.97 0 0)",
        }}
      />
      <div
        className="pointer-events-none absolute inset-0 -z-10 hidden dark:block"
        style={{
          backgroundImage:
            "radial-gradient(48rem 48rem at 0% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 90%), transparent 60%), radial-gradient(48rem 48rem at 100% 0%, color-mix(in oklab, var(--color-primary), transparent 92%), transparent 60%)",
        }}
      />

      {/* Modern Header */}
      <header className="sticky top-0 z-30 bg-white/80 dark:bg-slate-900/80 backdrop-blur-xl border-b border-slate-200 dark:border-slate-800">
        <div className="max-w-7xl mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div
              className="p-2 rounded-xl shadow-sm"
              style={{
                background:
                  "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 35%), transparent 60%), var(--color-brand-primary)",
              }}
            >
              <ShoppingBag className="h-5 w-5 text-white" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-slate-900 dark:text-white">
                Order Portal
              </h1>
              <div className="text-xs text-muted-foreground space-y-0.5">
                <p>Welcome, <span >{userName}</span></p>
                <div className="flex items-center gap-2 opacity-75">
                  <span className="flex items-center gap-1">
                    <Building2 className="h-3 w-3" />
                    {activeOrgName}
                  </span>
                  <span className="text-[10px] opacity-40">•</span>
                  <span className="flex items-center gap-1">
                    <MapPin className="h-3 w-3" />
                    {activeBranchName}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-3">
            {/* Context Selector for managing organization and branch */}
            {isAdmin && (
              <ContextSelector />
            )}

            {/* Budget Status */}
            {budgetVisible && <div className="hidden md:flex items-center gap-3 px-3 py-2 rounded-lg min-w-[220px] shadow-sm bg-slate-100/80 dark:bg-slate-800/80">
              <div
                className="flex h-7 w-7 items-center justify-center rounded-full"
                style={{
                  background:
                    "radial-gradient(circle at 30% 0%, color-mix(in oklab, var(--color-brand-accent), transparent 35%), transparent 60%), var(--color-brand-primary)",
                }}
              >
                <DollarSign className="h-4 w-4 text-white" />
              </div>
              <div className="text-sm w-full">
                <div className="flex items-center justify-between">
                  <p className="font-semibold text-slate-900 dark:text-white">
                    PKR {(remainingBudget / 100).toFixed(2)}
                  </p>
                  <p className="text-[11px] text-muted-foreground">
                    of PKR {(totalBudgetLimit / 100).toFixed(2)}
                  </p>
                </div>
                <div className="mt-1 h-1.5 w-full rounded-full bg-slate-200 dark:bg-slate-700 overflow-hidden">
                  <div
                    className={`h-full rounded-full ${budgetPercent < 60
                      ? "bg-[color:var(--color-brand-primary)]"
                      : budgetPercent < 85
                        ? "bg-amber-500"
                        : "bg-red-500"
                      }`}
                    style={{ width: `${budgetPercent}%` }}
                  />
                </div>
              </div>
            </div>}

            {isOrderPortal && <NotificationBell />}

            {/* Cart Button */}
            <Button
              onClick={() => setShowCart(!showCart)}
              variant={showCart ? "default" : "outline"}
              size="sm"
              className="gap-2"
            >
              <ShoppingBag className="h-4 w-4" />
              <span className="font-semibold">{cart.length}</span>
            </Button>

            {/* Home / Logout Button */}
            <Button
              onClick={async () => {
                const targetUrl = "/login"
                await signOut({
                  redirect: true,
                  callbackUrl: targetUrl
                })
              }}
              variant="ghost"
              size="icon"
              title={isAdmin ? "Back to Dashboard" : "Logout / Exit Order Portal"}
            >
              {isAdmin ? <Home className="h-4 w-4" /> : <LogOut className="h-4 w-4" />}
            </Button>
          </div>
        </div>
      </header>

      {/* Cart Drawer */}
      <Dialog open={showCart} onOpenChange={setShowCart}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cart</DialogTitle>
            <DialogDescription>Items ready to submit for purchase.</DialogDescription>
          </DialogHeader>

          {cart.length === 0 ? (
            <div className="py-10 text-center text-muted-foreground">
              <ShoppingBag className="mx-auto mb-4 h-12 w-12 opacity-40" />
              <p className="font-medium">Your cart is empty</p>
              <p className="text-xs">Browse the catalog and add products to get started.</p>
            </div>
          ) : (
            <div className="space-y-4">
              <div className="max-h-64 space-y-3 overflow-y-auto pr-1">
                {cart.map(item => {
                  const currentProduct = productsById.get(item.id)
                  const quantityBudgetRemaining = currentProduct?.quantityBudgetRemaining ?? item.quantityBudgetRemaining
                  const quantityBudgetAfterCart = typeof quantityBudgetRemaining === "number"
                    ? quantityBudgetRemaining - item.quantity
                    : null

                  return (
                  <Card key={item.id} className="p-3">
                    <div className="flex items-start gap-3">
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate text-slate-900 dark:text-white">{item.name}</p>
                        <p className="text-xs text-muted-foreground">{item.code}</p>
                        {!pricesHidden && item.priceCents !== null && (
                          <p className="text-xs mt-1 text-slate-500">PKR {(item.priceCents / 100).toFixed(2)} / {item.unit}</p>
                        )}
                        {!isOrderPortal && item.stock !== undefined && item.quantity > item.stock && (
                          <p className="text-xs mt-1 text-red-600 dark:text-red-400 font-medium">
                            ⚠️ Only {item.stock} available (quantity adjusted)
                          </p>
                        )}
                        {!isOrderPortal && item.stock !== undefined && item.stock > 0 && item.stock <= 10 && item.quantity <= item.stock && (
                          <p className="text-xs mt-1 text-yellow-600 dark:text-yellow-400">
                            Low stock: {formatQuantity(item.stock)} remaining
                          </p>
                        )}
                        {quantityBudgetAfterCart !== null && (
                          <p className={cn(
                            "mt-1 text-xs font-medium",
                            quantityBudgetAfterCart < 0
                              ? "text-red-600 dark:text-red-400"
                              : "text-indigo-600 dark:text-indigo-300"
                          )}>
                            {quantityBudgetAfterCart < 0
                              ? `Cart exceeds quantity budget by ${formatQuantity(Math.abs(quantityBudgetAfterCart))} ${item.unit}.`
                              : `Quantity budget remaining after cart: ${formatQuantity(quantityBudgetAfterCart)} ${item.unit}.`}
                          </p>
                        )}
                      </div>
                      <div className="flex items-center gap-2">
                        <Button
                          size="icon"
                          variant="outline"
                          onClick={() => updateQty(item.id, roundQuantity(item.quantity - (item.allowDecimalQuantity ? 1 : getProductStep(item))))}
                        >
                          <Minus className="h-4 w-4" />
                        </Button>
                        <span className="w-10 text-center text-sm font-semibold">{formatQuantity(item.quantity)}</span>
                        <Button
                          size="icon"
                          variant="outline"
                          onClick={() => {
                            const maxStock = item.stock || 0
                            if (item.quantity < maxStock) {
                              updateQty(item.id, roundQuantity(item.quantity + (item.allowDecimalQuantity ? 1 : getProductStep(item))))
                            } else {
                              toast({
                                title: "Maximum stock reached",
                                description: isOrderPortal
                                  ? `${item.name} is not available in a higher quantity.`
                                  : `Only ${formatQuantity(maxStock)} available for ${item.name}.`,
                                variant: "destructive"
                              })
                            }
                          }}
                          disabled={item.quantity >= (item.stock || 0)}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </div>
                      <Button
                        size="icon"
                        variant="ghost"
                        onClick={() => removeFromCart(item.id)}
                        title="Remove"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </Card>
                  )
                })}
              </div>

              <div className="space-y-2 rounded-lg border bg-slate-50 dark:bg-slate-800 p-3 text-sm">
                <div className="flex justify-between text-slate-600 dark:text-slate-300">
                  <span>Items</span>
                  <span>{cart.length}</span>
                </div>
                {!pricesHidden && (
                  <>
                    <div className="flex justify-between text-base font-semibold text-slate-900 dark:text-white">
                      <span>Total</span>
                      <span>PKR {(cartTotal / 100).toFixed(2)}</span>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Remaining budget after checkout: PKR {((remainingBudget - cartTotal) / 100).toFixed(2)}
                    </p>
                  </>
                )}
                {!pricesHidden && cartTotal > remainingBudget && (
                  <div className="flex items-center gap-2 rounded-md border border-red-200 bg-red-50 p-2 text-xs text-red-600 dark:border-red-900 dark:bg-red-950">
                    <AlertTriangle className="h-4 w-4" />
                    Cart exceeds remaining budget.
                  </div>
                )}
              </div>
            </div>
          )}

          <DialogFooter className="flex-col gap-2 sm:flex-row">
            <Button
              variant="outline"
              className="w-full sm:w-auto"
              onClick={() => setShowCart(false)}
            >
              Continue shopping
            </Button>
            <Button
              className="w-full sm:w-auto gap-2"
              disabled={!canCheckout}
              onClick={() => {
                setShowCart(false)
                setShowCheckout(true)
              }}
            >
              Proceed to checkout
              <ArrowRight className="h-4 w-4" />
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="max-w-7xl mx-auto p-4 md:p-6">
        {/* Tabs */}
        <div className="mb-6 flex gap-2 rounded-2xl bg-white/80 p-1 shadow-sm ring-1 ring-black/5 backdrop-blur-md dark:bg-slate-900/80">
          <Button
            onClick={() => { void handleTabChange("shop") }}
            variant={activeTab === "shop" ? "default" : "outline"}
            className="gap-2"
          >
            <Grid className="h-4 w-4" />
            Shop
          </Button>
          <Button
            onClick={() => { void handleTabChange("orders") }}
            variant={activeTab === "orders" ? "default" : "outline"}
            className="gap-2"
          >
            <Package className="h-4 w-4" />
            Active Orders ({ordersData?.items?.filter(isActiveOrder).length || 0})
          </Button>
          <Button
            onClick={() => { void handleTabChange("refunded") }}
            variant={activeTab === "refunded" ? "default" : "outline"}
            className="gap-2"
          >
            <TrendingDown className="h-4 w-4" />
            Refunded ({ordersData?.items?.filter(isRefundRelatedOrder).length || 0})
          </Button>
        </div>

        {activeTab === "orders" || activeTab === "refunded" ? (
          // Orders View
          <div className="space-y-4">
            {!ordersData ? (
              <div className="space-y-3">
                {Array.from({ length: 3 }).map((_, idx) => (
                  <Card key={idx} className="p-4 dark:bg-slate-900 dark:border-slate-800">
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex-1 space-y-2">
                        <Skeleton className="h-4 w-40" />
                        <Skeleton className="h-3 w-24" />
                      </div>
                      <Skeleton className="h-6 w-20" />
                    </div>
                    <Skeleton className="h-16 w-full" />
                  </Card>
                ))}
              </div>
            ) : !ordersData.items || ordersData.items.length === 0 ? (
              <div className="text-center py-16">
                <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium text-muted-foreground">No orders found</p>
              </div>
            ) : (
              <div className="space-y-3">
                {ordersData.items
                  .filter((order: any) => {
                    return activeTab === "refunded"
                      ? isRefundRelatedOrder(order)
                      : isActiveOrder(order)
                  })
                  .map((order: any) => {
                    const statusColors: Record<string, { bg: string; text: string; icon: any }> = {
                      pending: { bg: "bg-yellow-50 dark:bg-yellow-950", text: "text-yellow-700 dark:text-yellow-300", icon: Clock },
                      approved: { bg: "bg-blue-50 dark:bg-blue-950", text: "text-blue-700 dark:text-blue-300", icon: CheckCircle },
                      fulfilled: { bg: "bg-green-50 dark:bg-green-950", text: "text-green-700 dark:text-green-300", icon: CheckCircle },
                      rejected: { bg: "bg-red-50 dark:bg-red-950", text: "text-red-700 dark:text-red-300", icon: AlertTriangle },
                      refunded: { bg: "bg-slate-50 dark:bg-slate-950", text: "text-slate-700 dark:text-slate-300", icon: TrendingDown },
                    }
                    const statusInfo = statusColors[order.status?.toLowerCase()] || statusColors.pending
                    const StatusIcon = statusInfo.icon
                    const refundState = getRefundState(order)

                    return (
                      <Card key={order.id} className="p-4 hover:shadow-md transition-shadow dark:bg-slate-900 dark:border-slate-800">
                        <div className="flex items-start justify-between mb-3">
                          <div className="flex-1">
                            <div className="flex items-center gap-2 flex-wrap">
                              <p className="font-semibold text-slate-900 dark:text-white">Order {order.tid}</p>
                              <Badge variant="outline" className={`${statusInfo.bg} ${statusInfo.text} border-0`}>
                                <StatusIcon className="h-3 w-3 mr-1" />
                                {getOrderDerivedStatus({ status: order.status }).label}
                              </Badge>
                              {['FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(order.status?.toUpperCase()) && Number(order.refundAmountCents || 0) > 0 && (
                                <Badge variant="outline" className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                                  Partial Refund
                                </Badge>
                              )}
                            </div>
                            <p className="text-xs text-muted-foreground mt-1">
                              <Calendar className="h-3 w-3 inline mr-1" />
                              {new Date(order.createdAt).toLocaleDateString()} {new Date(order.createdAt).toLocaleTimeString()}
                            </p>
                            <p className="text-xs text-muted-foreground mt-0.5 font-mono">
                              ID: #{order.id}
                            </p>
                          </div>
                          <div className="text-right">
                            {!pricesHidden && order.totalCents !== null && (
                              <p className="font-bold text-lg text-slate-900 dark:text-white">PKR {(order.totalCents / 100).toFixed(2)}</p>
                            )}
                            <p className="text-xs text-muted-foreground">
                              {(() => {
                                const s = (order.status || "").toLowerCase()
                                if (s === "pending") return "Awaiting Approval"
                                if (s === "approved") {
                                  if (refundState === "full") return "Refunded"
                                  return "Active"
                                }
                                if (s === "fulfilled") {
                                  if (refundState === "full") return "Refunded"
                                  return "Completed"
                                }
                                if (s === "rejected") return "Cancelled"
                                if (s === "refunded") return "Refunded"
                                return s.charAt(0).toUpperCase() + s.slice(1)
                              })()}
                            </p>
                          </div>
                        </div>

                        {(order.status?.toUpperCase() === 'REJECTED') && order.rejectionReason && (
                          <div className="mb-3 rounded bg-red-50 p-2 text-xs text-red-700 dark:bg-red-950/30 dark:text-red-300 border border-red-100 dark:border-red-900">
                            <span className="font-semibold mr-1">Reason:</span>
                            {order.rejectionReason}
                          </div>
                        )}

                        {/* Order Items Preview */}
                        <div className="bg-slate-50 dark:bg-slate-800 rounded p-3 text-sm space-y-1">
                          <p className="font-medium text-muted-foreground">Items</p>
                          <p className="text-slate-600 dark:text-slate-300">
                            {(() => {
                              const s = (order.status || "").toLowerCase()
                              if (s === "pending") return "⏳ Waiting for approval..."
                              if (s === "approved") return "✓ Active - Processing"
                              if (s === "fulfilled") return "🎉 Order completed and delivered"
                              if (s === "rejected") return "❌ Order was rejected"
                              if (s === "refunded") return "💰 Order has been refunded"
                              return null
                            })()}
                          </p>
                        </div>

                        {/* Order Timeline */}
                        <div className="mt-3 pt-3 border-t space-y-2">
                          <div className="flex items-center gap-2 text-xs">
                            <CheckCircle className="h-4 w-4 text-green-600" />
                            <span className="text-muted-foreground">Order Created</span>
                            <span className="text-slate-600 dark:text-slate-400">{new Date(order.createdAt).toLocaleDateString()}</span>
                          </div>
                          {(order.status === "approved" || order.status === "fulfilled" || order.status === "refunded") && (
                            <div className="flex items-center gap-2 text-xs">
                              <CheckCircle className="h-4 w-4 text-blue-600" />
                              <span className="text-muted-foreground">Order Approved</span>
                            </div>
                          )}
                          {(order.status === "fulfilled" || (order.status === "refunded" && order.statusAtRefund?.toLowerCase() === "fulfilled")) && (
                            <div className="flex items-center gap-2 text-xs">
                              <CheckCircle className="h-4 w-4 text-green-600" />
                              <span className="text-muted-foreground">Order Fulfilled</span>
                            </div>
                          )}
                          {refundState !== "none" && (
                            <div className="flex items-center gap-2 text-xs">
                              <TrendingDown className="h-4 w-4 text-red-600" />
                              <span className="text-muted-foreground">
                                {refundState === "full" ? "Fully Refunded" : "Partial Refund Applied"}
                              </span>
                            </div>
                          )}
                        </div>

                        {/* Action Buttons */}
                        <div className="mt-4 pt-3 border-t flex gap-2">
                          <Button
                            onClick={() => {
                              setSelectedOrder(order)
                              setShowOrderDetail(true)
                            }}
                            variant="outline"
                            size="sm"
                            className="flex-1 gap-2"
                          >
                            <RefreshCw className="h-4 w-4" />
                            View Details
                          </Button>
                          <ReceiptIconButton orderId={order.id} />
                        </div>
                      </Card>
                    )
                  })}
                {/* Empty State for Specific Filter */}
                {ordersData.items.filter((order: any) => {
                  return activeTab === "refunded"
                    ? isRefundRelatedOrder(order)
                    : isActiveOrder(order)
                }).length === 0 && (
                    <div className="text-center py-16">
                      {activeTab === "refunded" ? (
                        <TrendingDown className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                      ) : (
                        <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                      )}
                      <p className="text-lg font-medium text-muted-foreground">
                        {activeTab === "refunded" ? "No refunded orders" : "No active orders"}
                      </p>
                    </div>
                  )}
              </div>
            )}
          </div>
        ) : (
          // Shop View
          <>
            {/* Search & Filters */}
            <div className="mb-8 space-y-4">
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <div className="relative md:col-span-2">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                  <Input
                    placeholder="Search products by name or code..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="pl-9 h-11 text-base"
                    suppressHydrationWarning
                  />
                </div>
                <select
                  value={sortBy}
                  onChange={(e) => setSortBy(e.target.value)}
                  className="px-3 py-2 border rounded-lg bg-white dark:bg-slate-800 text-base font-medium"
                >
                  <option value="name">Sort: Name (A-Z)</option>
                  {!pricesHidden && <option value="price-low">Price: Low to High</option>}
                  {!pricesHidden && <option value="price-high">Price: High to Low</option>}
                  <option value="rating">Rating: Highest</option>
                </select>
              </div>

              {/* Category Ribbon */}
              <div className="relative -mx-4 px-4 overflow-hidden">
                <div className="flex items-center gap-2 overflow-x-auto pb-4 no-scrollbar scroll-smooth">
                  {categories.map((cat) => (
                    <Button
                      key={cat}
                      onClick={() => setActiveCategory(cat)}
                      variant={activeCategory === cat ? "default" : "outline"}
                      className={cn(
                        "rounded-full px-5 py-2 whitespace-nowrap text-xs font-bold transition-all duration-300",
                        activeCategory === cat
                          ? "shadow-lg shadow-blue-500/25 bg-blue-600 border-blue-600"
                          : "bg-white/50 backdrop-blur-md dark:bg-slate-800/50 border-slate-200/50 dark:border-slate-700/50"
                      )}
                    >
                      {cat}
                    </Button>
                  ))}
                </div>
              </div>

              {/* Budget Warning */}
              {!pricesHidden && cartTotal > remainingBudget && (
                <div className="p-3 bg-red-50/50 backdrop-blur-sm dark:bg-red-950/30 border border-red-200/50 dark:border-red-800/50 rounded-xl flex items-center gap-2">
                  <AlertTriangle className="h-4 w-4 text-red-600 dark:text-red-400" />
                  <p className="text-sm font-medium text-red-700 dark:text-red-300">Cart exceeds remaining budget</p>
                </div>
              )}
            </div>

            {/* Products header */}
            <div className="mb-4 flex items-center justify-between">
              <div>
                <h2 className="text-sm font-semibold tracking-tight text-slate-900 dark:text-slate-100">
                  Products
                </h2>
                <p className="text-xs text-muted-foreground">
                  Showing curated items available for your branch.
                </p>
              </div>
              <div className="text-xs text-muted-foreground">
                {totalProducts > 0 && (
                  <span>
                    {totalProducts} item{totalProducts !== 1 ? "s" : ""} found
                  </span>
                )}
              </div>
            </div>

            {/* Products Grid */}
            {isLoadingInventory ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {Array.from({ length: pageSize }).map((_, idx) => (
                  <Card key={idx} className="overflow-hidden h-full flex flex-col dark:bg-slate-900 dark:border-slate-800">
                    <Skeleton className="h-40 w-full" />
                    <div className="p-4 space-y-3 flex-1 flex flex-col">
                      <Skeleton className="h-4 w-3/4" />
                      <Skeleton className="h-3 w-1/2" />
                      <div className="flex-1" />
                      <Skeleton className="h-6 w-1/3" />
                    </div>
                  </Card>
                ))}
              </div>
            ) : filteredProducts.length === 0 ? (
              <div className="text-center py-16">
                <Package className="h-12 w-12 text-muted-foreground mx-auto mb-4 opacity-50" />
                <p className="text-lg font-medium text-muted-foreground">No products found</p>
              </div>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
                {paginatedProducts.map(product => {
                  const itemInCart = cart.find(i => i.id === product.id)
                  const productStep = getProductStep(product)
                  const defaultQty = (product.stock || 0) > 0 ? (product.allowDecimalQuantity ? 1 : productStep) : 0
                  const selectionQty = cardQuantities[product.id] ?? itemInCart?.quantity ?? defaultQty
                  const isModified = selectionQty !== (itemInCart?.quantity || 0)

                  return (
                    <div
                      key={product.id}
                      onClick={() => openProductDetail(product)}
                      className="group cursor-pointer"
                    >
                      <Card className="overflow-hidden hover:shadow-2xl hover:shadow-blue-500/10 transition-all duration-500 transform hover:-translate-y-2 h-full flex flex-col bg-white/40 dark:bg-slate-900/40 backdrop-blur-xl border-white/20 dark:border-slate-800/50 shadow-sm ring-1 ring-black/5">
                        {/* Product Image */}
                        <div className="relative h-48 overflow-hidden group-hover:bg-gradient-to-tl transition-all bg-gradient-to-br from-slate-100 to-slate-200 dark:from-slate-800 dark:to-slate-700">
                          {product.imageUrl ? (
                            <img
                              src={product.imageUrl}
                              alt={product.name}
                              className="w-full h-full object-cover group-hover:scale-110 transition-transform duration-300"
                            />
                          ) : (
                            <div className="w-full h-full flex items-center justify-center">
                              <ShoppingBag className="h-16 w-16 text-slate-400 opacity-30" />
                            </div>
                          )}

                          {/* Stock / quantity budget badge */}
                          {!isOrderPortal && product.stock !== undefined && (
                            <Badge
                              className={cn(
                                "absolute top-2 right-2 border-0 shadow-sm",
                                product.stock > 10
                                  ? "bg-emerald-500 text-white"
                                  : product.stock > 0
                                    ? "bg-amber-500 text-white animate-pulse"
                                    : "bg-rose-500 text-white"
                              )}
                            >
                              <div className="flex items-center gap-1.5 px-0.5">
                                <div className={cn("h-1.5 w-1.5 rounded-full bg-white", product.stock > 0 && "animate-ping")} />
                                {product.stock > 0 ? `${formatQuantity(product.stock)} in stock` : "Out of stock"}
                              </div>
                            </Badge>
                          )}
                          {showQuantityRemainingBadge && typeof product.quantityBudgetRemaining === "number" && (
                            <Badge
                              className={cn(
                                "absolute top-2 right-2 border-0 shadow-sm text-white",
                                product.quantityBudgetRemaining < 10 ? "bg-rose-500" : "bg-emerald-500"
                              )}
                            >
                              <div className="flex items-center gap-1.5 px-0.5">
                                <div className="h-1.5 w-1.5 rounded-full bg-white" />
                                {formatQuantity(product.quantityBudgetRemaining)} remaining
                              </div>
                            </Badge>
                          )}

                          {/* Highlight Badge */}
                          <Badge
                            className="absolute top-2 left-2 text-[11px] px-2 py-0.5 font-medium border-0"
                            style={{
                              background:
                                "color-mix(in oklab, var(--color-brand-primary), transparent 10%)",
                              color: "white",
                            }}
                          >
                            <Zap className="h-3 w-3 mr-1" />
                            Trending
                          </Badge>

                          {/* Discount Badge */}
                          {!pricesHidden && product.discountActive && (
                            <Badge
                              className="absolute bottom-2 left-2 bg-red-500 text-white text-[10px] px-1.5 py-0.5 border-0 font-bold"
                            >
                              {product.discountType === 'percent' ? `${product.discountValue}% OFF` : `PKR ${product.discountValue} OFF`}
                            </Badge>
                          )}
                        </div>

                        {/* Product Info */}
                        <div className="p-4 space-y-3 flex-1 flex flex-col">
                          {/* Name & Code */}
                          <div>
                            <h3 className="font-bold text-sm line-clamp-2 text-slate-900 dark:text-white group-hover:text-blue-600 dark:group-hover:text-blue-400 transition-colors">
                              {product.name}
                            </h3>
                            <p className="text-xs text-muted-foreground font-mono">{product.code}</p>
                            {product.description && (
                              <p className="text-xs text-slate-500 line-clamp-1 mt-1">
                                {product.description}
                              </p>
                            )}
                          </div>

                          {/* Rating hidden until product rating is supported.
                          <div className="flex items-center gap-1">
                            {[...Array(5)].map((_, i) => (
                              <Star
                                key={i}
                                className={`h-3 w-3 ${i < Math.floor(product.rating || 0)
                                  ? "fill-yellow-400 text-yellow-400"
                                  : "text-slate-300"
                                  }`}
                              />
                            ))}
                            <span className="text-xs text-muted-foreground ml-1">
                              {(product.rating || 0).toFixed(1)}
                            </span>
                          </div>
                          */}

                          {/* Spacer */}
                          <div className="flex-1" />

                          {/* Price & Unit */}
                          <div className="flex flex-col gap-2 pt-2 border-t border-slate-200 dark:border-slate-700">
                            <div className="flex items-center justify-between">
                              <div>
                                {!pricesHidden && product.discountActive && product.discountType && product.priceCents !== null && (
                                  <div className="flex items-center gap-2">
                                    <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                                      PKR {((product.priceCents - (product.discountType === 'percent' ? (product.priceCents * (product.discountValue || 0) / 100) : ((product.discountValue || 0) * 100))) / 100).toFixed(2)}
                                    </p>
                                    <p className="text-sm text-muted-foreground line-through">
                                      PKR {(product.priceCents / 100).toFixed(2)}
                                    </p>
                                  </div>
                                )}
                                {!pricesHidden && !product.discountActive && product.priceCents !== null && (
                                  <p className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                                    PKR {(product.priceCents / 100).toFixed(2)}
                                  </p>
                                )}
                                <p className="text-xs text-muted-foreground">per {product.unit}</p>
                              </div>

                              {/* Quantity Selector */}
                              <div className="flex items-center gap-1.5 bg-slate-100 dark:bg-slate-800 p-1 rounded-lg border border-slate-200 dark:border-slate-700">
                                <Button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (selectionQty > 0) {
                                      const step = product.allowDecimalQuantity ? 1 : productStep
                                      setCardQuantities(prev => ({
                                        ...prev,
                                        [product.id]: Math.max(0, roundQuantity(selectionQty - step))
                                      }))
                                    }
                                  }}
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-md hover:bg-white dark:hover:bg-slate-700"
                                  disabled={product.stock === 0 || selectionQty === 0}
                                >
                                  <Minus className="h-3.5 w-3.5" />
                                </Button>
                                {product.allowDecimalQuantity ? (
                                  <input
                                    type="number"
                                    step="any"
                                    min="0"
                                    max={product.stock || 999}
                                    value={selectionQty || ""}
                                    onChange={(e) => {
                                      e.stopPropagation()
                                      const val = parseFloat(e.target.value)
                                      setCardQuantities(prev => ({
                                        ...prev,
                                        [product.id]: Number.isFinite(val) && val >= 0 ? roundQuantity(val) : 0,
                                      }))
                                    }}
                                    onClick={(e) => e.stopPropagation()}
                                    onFocus={(e) => e.stopPropagation()}
                                    className="w-12 text-center text-xs font-bold text-slate-900 dark:text-white bg-transparent border-none outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                                    disabled={product.stock === 0}
                                    placeholder="0"
                                  />
                                ) : (
                                  <span className="w-8 text-center text-xs font-bold text-slate-900 dark:text-white">
                                    {formatQuantity(selectionQty)}
                                  </span>
                                )}
                                <Button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    const maxStock = product.stock || 999
                                    if (selectionQty < maxStock) {
                                      const step = product.allowDecimalQuantity ? 1 : productStep
                                      setCardQuantities(prev => ({
                                        ...prev,
                                        [product.id]: Math.min(maxStock, roundQuantity(selectionQty + step))
                                      }))
                                    } else {
                                      toast({ title: "Max stock reached", variant: "destructive" })
                                    }
                                  }}
                                  variant="ghost"
                                  size="icon"
                                  className="h-7 w-7 rounded-md hover:bg-white dark:hover:bg-slate-700"
                                  disabled={product.stock === 0 || selectionQty >= (product.stock || 0)}
                                >
                                  <Plus className="h-3.5 w-3.5" />
                                </Button>
                              </div>

                              {/* Remove/Clear Button */}
                              {(selectionQty > 0 || itemInCart) && (
                                <Button
                                  onClick={(e) => {
                                    e.stopPropagation()
                                    if (itemInCart) {
                                      removeFromCart(product.id)
                                      toast({ title: `${product.name} removed from cart` })
                                    }
                                    setCardQuantities(prev => {
                                      const { [product.id]: _, ...rest } = prev
                                      return rest
                                    })
                                  }}
                                  variant="ghost"
                                  size="icon"
                                  className="h-8 w-8 rounded-lg text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-900/20"
                                  title="Clear All"
                                >
                                  <Trash2 className="h-4 w-4" />
                                </Button>
                              )}
                            </div>

                            {itemInCart && !isModified && (
                              <div className="flex items-center gap-1 text-[10px] font-medium text-green-600 dark:text-green-400">
                                <CheckCircle className="h-3 w-3" />
                                <span>{formatQuantity(itemInCart.quantity)} in cart</span>
                              </div>
                            )}
                            {isModified && (
                              <div className="flex items-center gap-1 text-[10px] font-medium text-amber-600 dark:text-amber-400">
                                <RefreshCw className="h-3 w-3" />
                                <span>Changes not saved</span>
                              </div>
                            )}

                            <Button
                              onClick={(e) => {
                                e.stopPropagation()
                                if (isModified) {
                                  if (itemInCart) {
                                    updateQty(product.id, selectionQty)
                                  } else {
                                    addToCart(product, selectionQty)
                                  }
                                  setCardQuantities(prev => {
                                    const { [product.id]: _, ...rest } = prev
                                    return rest
                                  })
                                } else if (itemInCart) {
                                  setShowCart(true)
                                } else {
                                  addToCart(product, productStep)
                                }
                              }}
                              size="sm"
                              disabled={product.stock === 0 || (selectionQty === 0 && !itemInCart)}
                              className={`w-full gap-2 shadow-sm ${itemInCart && !isModified ? 'bg-green-600 hover:bg-green-700' : ''}`}
                            >
                              {isModified ? (
                                <>
                                  <RefreshCw className="h-4 w-4" />
                                  <span>{itemInCart ? 'Update Cart' : `Add ${formatQuantity(selectionQty)} to Cart`}</span>
                                </>
                              ) : itemInCart ? (
                                <>
                                  <ShoppingBag className="h-4 w-4" />
                                  <span>Open Cart</span>
                                </>
                              ) : (
                                <>
                                  <Plus className="h-4 w-4" />
                                  <span>Add to Cart</span>
                                </>
                              )}
                            </Button>
                          </div>
                        </div>
                      </Card>
                    </div>
                  );
                })}
              </div>
            )}

            {/* Pagination controls */}
            {filteredProducts.length > 0 && (
              <div className={cn(
                "mt-6 flex flex-col gap-3 md:flex-row md:items-center md:justify-between",
                cart.length > 0 && !showCart && "mb-20"
              )}>
                <div className="text-xs text-muted-foreground">
                  {(() => {
                    const start = (currentPage - 1) * pageSize + 1
                    const end = Math.min(currentPage * pageSize, totalProducts)
                    return `Showing ${start.toLocaleString()}–${end.toLocaleString()} of ${totalProducts.toLocaleString()} products`
                  })()}
                </div>
                <div className="flex items-center gap-3">
                  <div className="flex items-center gap-1 text-xs text-muted-foreground">
                    <span>Rows per page:</span>
                    <select
                      value={pageSize}
                      onChange={(e) => setPageSize(Number(e.target.value))}
                      className="h-7 rounded-md border bg-background px-2 text-xs"
                    >
                      {[8, 12, 16, 24].map(size => (
                        <option key={size} value={size}>{size}</option>
                      ))}
                    </select>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={currentPage === 1}
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                    >
                      <ArrowLeft className="h-3 w-3" />
                    </Button>
                    <span className="text-xs text-muted-foreground px-1 min-w-[72px] text-center">
                      Page {currentPage} of {totalPages}
                    </span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="h-8 w-8"
                      disabled={currentPage === totalPages || totalProducts === 0}
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                    >
                      <ArrowRight className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              </div>
            )}
            {/* Sticky Mini-Cart */}
            {cart.length > 0 && !showCart && (
              <div className="fixed bottom-6 right-6 z-40 transition-all duration-500 animate-in fade-in slide-in-from-bottom-5">
                <Button
                  onClick={() => setShowCart(true)}
                  className="h-14 px-6 rounded-2xl shadow-2xl shadow-blue-500/40 bg-blue-600 hover:bg-blue-700 flex items-center gap-4 group ring-2 ring-white/20"
                >
                  <div className="relative">
                    <ShoppingBag className="h-6 w-6 text-white group-hover:scale-110 transition-transform" />
                    <span className="absolute -top-2 -right-2 h-5 w-5 rounded-full bg-white text-blue-600 text-[10px] font-bold flex items-center justify-center shadow-sm">
                      {cart.length}
                    </span>
                  </div>
                  <div className="flex flex-col items-start leading-tight">
                    <span className="text-[10px] uppercase tracking-widest font-bold text-blue-100">Checkout</span>
                    {!pricesHidden && <span className="text-sm font-bold text-white font-mono">{formatPKR(cartTotal / 100)}</span>}
                  </div>
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {/* Product Detail Modal */}
      <Dialog open={showProductDetail} onOpenChange={setShowProductDetail}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Product Details</DialogTitle>
          </DialogHeader>

          {selectedProduct && (
            <div className="space-y-4">
              {/* Product Image */}
              <div className="h-64 bg-gradient-to-br from-slate-200 to-slate-300 dark:from-slate-700 dark:to-slate-800 rounded-lg overflow-hidden">
                {selectedProduct.imageUrl ? (
                  <img
                    src={selectedProduct.imageUrl}
                    alt={selectedProduct.name}
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <div className="w-full h-full flex items-center justify-center">
                    <ShoppingBag className="h-20 w-20 text-slate-400 opacity-30" />
                  </div>
                )}
              </div>

              {/* Details */}
              <div className="space-y-3">
                <div>
                  <h3 className="text-xl font-bold text-slate-900 dark:text-white">
                    {selectedProduct.name}
                  </h3>
                  <p className="text-sm text-muted-foreground font-mono">
                    Code: {selectedProduct.code}
                  </p>
                </div>

                {selectedProduct.description && (
                  <div className="p-3 bg-slate-50 dark:bg-slate-800 rounded-lg border border-slate-100 dark:border-slate-700">
                    <p className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-1">Description</p>
                    <p className="text-sm text-slate-700 dark:text-slate-300 leading-relaxed">
                      {selectedProduct.description}
                    </p>
                  </div>
                )}

                <div className="flex items-center justify-between p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                  <div>
                    {!pricesHidden && selectedProduct.priceCents !== null && (
                      <>
                        <p className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                          PKR {(selectedProduct.priceCents / 100).toFixed(2)}
                        </p>
                        <p className="text-sm text-muted-foreground">per {selectedProduct.unit}</p>
                      </>
                    )}
                  </div>
                  {!isOrderPortal && (
                  <div>
                    <p className="text-sm font-medium text-muted-foreground">Stock</p>
                    <p className="text-2xl font-bold text-slate-900 dark:text-white">
                      {formatQuantity(selectedProduct.stock || 0)}
                    </p>
                  </div>
                  )}
                </div>

                {/* Rating hidden until product rating is supported.
                <div className="flex items-center gap-2">
                  {[...Array(5)].map((_, i) => (
                    <Star
                      key={i}
                      className={`h-4 w-4 ${i < Math.floor(selectedProduct.rating || 0)
                        ? "fill-yellow-400 text-yellow-400"
                        : "text-slate-300"
                        }`}
                    />
                  ))}
                  <span className="text-sm text-muted-foreground">
                    {(selectedProduct.rating || 0).toFixed(1)} rating
                  </span>
                </div>
                */}

                {/* Quantity Selector */}
                <div className="space-y-2">
                  <label className="text-sm font-medium">Quantity</label>
                  <div className="flex items-center gap-2">
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => {
                        if (selectedProduct.allowDecimalQuantity) {
                          setTempQuantity(Math.max(0, roundQuantity(tempQuantity - 1)))
                        } else {
                          setTempQuantity(clampProductQuantity(selectedProduct, roundQuantity(tempQuantity - getProductStep(selectedProduct))))
                        }
                      }}
                    >
                      <Minus className="h-4 w-4" />
                    </Button>
                    <Input
                      type="number"
                      step={selectedProduct.allowDecimalQuantity ? "any" : getProductStep(selectedProduct)}
                      value={tempQuantity}
                      onChange={(e) => {
                        const val = parseQuantity(e.target.value)
                        if (selectedProduct.allowDecimalQuantity) {
                          if (Number.isFinite(val) && val >= 0) {
                            setTempQuantity(Math.min(selectedProduct.stock || 999, roundQuantity(val)))
                          }
                        } else {
                          setTempQuantity(clampProductQuantity(selectedProduct, Number.isFinite(val) ? val : getProductStep(selectedProduct)))
                        }
                      }}
                      className="text-center h-10 font-bold text-lg"
                      min={selectedProduct.allowDecimalQuantity ? 0 : getProductStep(selectedProduct)}
                      max={selectedProduct.stock || 999}
                    />
                    <Button
                      size="icon"
                      variant="outline"
                      onClick={() => {
                        const maxStock = selectedProduct.stock || 999
                        const step = selectedProduct.allowDecimalQuantity ? 1 : getProductStep(selectedProduct)
                        setTempQuantity(Math.min(maxStock, roundQuantity(tempQuantity + step)))
                      }}
                      disabled={tempQuantity >= (selectedProduct.stock || 999)}
                    >
                      <Plus className="h-4 w-4" />
                    </Button>
                  </div>
                  {!isOrderPortal && selectedProduct.stock !== undefined && selectedProduct.stock < 10 && (
                    <p className="text-xs text-yellow-600 dark:text-yellow-400">
                      {selectedProduct.stock === 0
                        ? "Out of stock"
                        : `Only ${formatQuantity(selectedProduct.stock)} available`}
                    </p>
                  )}
                </div>
              </div>

              <DialogFooter>
                <Button
                  variant="outline"
                  onClick={() => setShowProductDetail(false)}
                >
                  Close
                </Button>
                <Button
                  onClick={addToCartFromDetail}
                  disabled={selectedProduct.stock === 0}
                  className="gap-2"
                >
                  <Plus className="h-4 w-4" />
                  Add to Cart
                </Button>
              </DialogFooter>
            </div>
          )}
        </DialogContent>
      </Dialog>

      {/* Checkout Modal */}
      <Dialog open={showCheckout} onOpenChange={setShowCheckout}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Order Confirmation</DialogTitle>
            <DialogDescription>Review your order before placing</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="max-h-48 overflow-y-auto space-y-2">
              {cart.map(item => (
                <div key={item.id} className="flex justify-between text-sm">
                  <span>{item.name} x{formatQuantity(item.quantity)}</span>
                  {!pricesHidden && item.priceCents !== null && (
                    <span className="font-semibold">PKR {(calculateLineCents(item.priceCents, item.quantity) / 100).toFixed(2)}</span>
                  )}
                </div>
              ))}
            </div>

            <div className="h-px bg-slate-200 dark:bg-slate-700" />

            {!pricesHidden && <div className="space-y-2 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
              <div className="flex justify-between font-bold text-lg">
                <span>Total:</span>
                <span className="text-blue-600 dark:text-blue-400">
                  PKR {(cartTotal / 100).toFixed(2)}
                </span>
              </div>
              <p className="text-xs text-muted-foreground">
                Remaining Budget: PKR {((remainingBudget - cartTotal) / 100).toFixed(2)}
              </p>
            </div>}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setShowCheckout(false)}
            >
              Back
            </Button>
            <Button onClick={placeOrder} disabled={!canCheckout || isPlacingOrder}>
              {isPlacingOrder ? "Placing Order..." : "Place Order"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Order Detail Dialog */}
      <Dialog open={showOrderDetail} onOpenChange={setShowOrderDetail}>
        <DialogContent className="w-[calc(100vw-2rem)] max-h-[90vh] overflow-x-hidden overflow-y-auto sm:max-w-[calc(100vw-2rem)] lg:max-w-[58rem]">
          <DialogHeader>
            <DialogTitle>Order Details</DialogTitle>
          </DialogHeader>

          {selectedOrder && (
            <div className="min-w-0 space-y-6">
              {/* Order Information */}
              <div className="grid grid-cols-2 gap-4">
                <div className="min-w-0">
                  <p className="text-sm text-muted-foreground mb-1">Transaction ID</p>
                  <p className="break-all font-mono font-semibold text-slate-900 dark:text-white">{selectedOrder.tid}</p>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Order ID</p>
                  <p className="font-semibold text-slate-900 dark:text-white">{selectedOrder.id}</p>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Status</p>
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="outline" className="w-fit">
                      {getOrderDerivedStatus({ status: selectedOrder.status }).label}
                    </Badge>
                    {['FULFILLED', 'PARTIAL', 'PARTIALLY_FULFILLED'].includes(selectedOrder.status?.toUpperCase()) && Number(selectedOrder.refundAmountCents || 0) > 0 && (
                      <Badge variant="outline" className="px-2 py-0.5 text-[9px] font-bold uppercase tracking-wider rounded-lg border border-amber-300 dark:border-amber-700 bg-amber-50 dark:bg-amber-950/40 text-amber-600 dark:text-amber-400">
                        Partial Refund
                      </Badge>
                    )}
                  </div>
                </div>
                <div>
                  <p className="text-sm text-muted-foreground mb-1">Date</p>
                  <p className="text-slate-900 dark:text-white">
                    {new Date(selectedOrder.createdAt).toLocaleDateString()}
                  </p>
                </div>
              </div>

              {(selectedOrder.status.toLowerCase() === 'rejected' || selectedOrder.status === 'REJECTED') && selectedOrder.rejectionReason && (
                <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950/20">
                  <p className="mb-1 text-xs font-semibold uppercase text-red-700 dark:text-red-300">
                    Rejection Reason
                  </p>
                  <p className="text-sm text-red-900 dark:text-red-200">
                    {selectedOrder.rejectionReason}
                  </p>
                </div>
              )}

              {/* Order Items List */}
              <div className="rounded-lg border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 overflow-hidden">
                <div className="bg-slate-50 dark:bg-slate-800/50 px-4 py-3 border-b border-slate-200 dark:border-slate-800 flex flex-wrap justify-between items-center gap-2">
                  <h3 className="font-semibold text-sm">Ordered Items</h3>
                  {orderDetailsData?.items?.[0]?.orderItems?.some((item: any) => (item.quantityRefunded || 0) > 0) && (
                    <Badge variant="outline" className="bg-yellow-50 text-yellow-700 border-yellow-200 text-[10px]">
                      Contains Refunds
                    </Badge>
                  )}
                </div>
                <div className="divide-y divide-slate-100 dark:divide-slate-800">
                  {orderDetailsData?.items?.[0]?.orderItems ? (
                    orderDetailsData.items[0].orderItems.map((item: any) => {
                      const isFullyRefunded = (item.quantityRefunded || 0) >= item.quantity
                      const isPartiallyRefunded = (item.quantityRefunded || 0) > 0 && !isFullyRefunded

                      return (
                        <div key={item.id} className={`flex flex-wrap justify-between items-center gap-3 p-4 ${isFullyRefunded ? "opacity-50 bg-slate-50/50" : ""}`}>
                          <div className="min-w-0 flex-1">
                            <div className="flex flex-wrap items-center gap-2">
                              <p className="break-words font-medium text-sm text-slate-900 dark:text-white">{item.productName}</p>
                              {isFullyRefunded && <Badge variant="destructive" className="text-[10px] h-4">REFUNDED</Badge>}
                              {isPartiallyRefunded && <Badge variant="outline" className="text-[10px] h-4 border-yellow-500 text-yellow-600">PARTIAL REFUND</Badge>}
                            </div>
                            <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted-foreground mt-0.5">
                              Qty: <span className="font-semibold">{formatQuantity(item.quantity)}</span>
                              {!pricesHidden && item.priceCents !== null && <> x {formatPKR(item.priceCents / 100)}</>}
                              {item.quantityRefunded > 0 && (
                                <span className="text-red-500 font-medium">(-{formatQuantity(item.quantityRefunded)} refunded)</span>
                              )}
                            </p>
                          </div>
                          {!pricesHidden && item.priceCents !== null && (
                            <div className="text-right">
                              <p className={`font-semibold text-sm ${isFullyRefunded ? "line-through text-muted-foreground" : "text-slate-900 dark:text-white"}`}>
                                {formatPKR((calculateLineCents(item.priceCents, item.quantity)) / 100)}
                              </p>
                              {item.quantityRefunded > 0 && (
                                <p className="text-[10px] text-red-500 font-bold">
                                  - {formatPKR((calculateLineCents(item.priceCents, item.quantityRefunded || 0)) / 100)}
                                </p>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })
                  ) : (
                    <div className="p-8 text-center text-muted-foreground text-sm">
                      Loading items...
                    </div>
                  )}
                </div>
              </div>

              {/* Itemized Refund Summary */}
              {!pricesHidden && orderDetailsData?.items?.[0]?.orderItems?.some((item: any) => (item.quantityRefunded || 0) > 0) && (
                <div className="rounded-lg border border-yellow-200 dark:border-yellow-800 bg-yellow-50/30 dark:bg-yellow-900/10 overflow-hidden">
                  <div className="px-4 py-2 border-b border-yellow-100 dark:border-yellow-900 bg-yellow-100/50 dark:bg-yellow-900/30">
                    <p className="text-xs font-bold text-yellow-800 dark:text-yellow-200 uppercase tracking-wider">Refund Summary</p>
                  </div>
                  <div className="p-4 space-y-2">
                    {orderDetailsData.items[0].orderItems
                      .filter((item: any) => (item.quantityRefunded || 0) > 0)
                      .map((item: any) => (
                        <div key={`refund-sum-${item.id}`} className="flex flex-wrap justify-between gap-x-4 gap-y-1 text-xs">
                          <span className="min-w-0 break-words">{formatQuantity(item.quantityRefunded || 0)}x {item.productName}</span>
                          <span className="shrink-0 font-bold text-red-600">-{formatPKR((calculateLineCents(item.priceCents, item.quantityRefunded || 0)) / 100)}</span>
                        </div>
                      ))}
                    <div className="pt-2 border-t border-yellow-200 dark:border-yellow-800 flex justify-between font-bold text-sm">
                      <span>Total Refunded</span>
                      <span className="text-red-600">{formatPKR((selectedOrder.refundAmountCents || 0) / 100)}</span>
                    </div>
                  </div>
                </div>
              )}

              {!pricesHidden && selectedOrder.totalCents !== null && <div className="space-y-2 p-3 bg-slate-50 dark:bg-slate-800 rounded-lg">
                <div className="flex justify-between">
                  <span className="font-bold">Total</span>
                  <span className="font-bold text-lg text-blue-600 dark:text-blue-400">
                    PKR {(selectedOrder.totalCents / 100).toFixed(2)}
                  </span>
                </div>
              </div>}

              {/* Refund Management */}
              <RefundManagement
                orderId={selectedOrder.id}
                orderTotalCents={selectedOrder.totalCents}
                orderStatus={selectedOrder.status}
                createdAt={selectedOrder.createdAt}
                pricesHidden={pricesHidden}
                initialOrderItems={orderDetailsData?.items?.[0]?.orderItems || selectedOrder.orderItems || []}
                onRefundSuccess={() => {
                  // Refresh orders data
                  mutateOrders?.()
                }}
                refundAmountCents={selectedOrder.refundAmountCents}
                refundedAt={selectedOrder.refundedAt}
                refundReason={selectedOrder.refundReason}
              />

              {isOrderPortal && selectedOrder.status.toUpperCase() === "APPROVED" && selectedOrder.approvalToken && (
                <section className="min-w-0 space-y-3 border-t pt-4" aria-labelledby="fulfillment-token-heading">
                  <h3 id="fulfillment-token-heading" className="text-lg font-semibold">Fulfillment Token</h3>
                  <div className="space-y-4 rounded-2xl border border-indigo-200 bg-indigo-50/60 p-4 dark:border-indigo-800 dark:bg-indigo-950/20 sm:p-5">
                    <p className="text-xs font-semibold uppercase tracking-wider text-indigo-600 dark:text-indigo-400">
                      Share with Super Admin
                    </p>
                    <div className="flex min-w-0 items-stretch gap-2 sm:gap-3">
                      <div className="min-w-0 flex-1 overflow-x-auto rounded-xl border border-indigo-200 bg-white px-4 py-3 font-mono text-lg font-bold tracking-[0.2em] text-indigo-700 shadow-sm dark:border-indigo-800 dark:bg-slate-950 dark:text-indigo-300 sm:text-xl">
                        {selectedOrder.approvalToken}
                      </div>
                      <Button
                        type="button"
                        size="icon"
                        variant="outline"
                        onClick={copyFulfillmentToken}
                        aria-label="Copy fulfillment token"
                        title="Copy fulfillment token"
                        className="h-auto min-h-12 w-12 shrink-0 rounded-xl border-indigo-200 bg-white text-indigo-600 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-slate-950 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
                      >
                        <Copy className="h-5 w-5" />
                      </Button>
                    </div>
                    <Button
                      type="button"
                      variant="outline"
                      disabled={isSendingTokenEmail}
                      onClick={sendFulfillmentToken}
                      className="h-11 w-full rounded-xl border-indigo-200 bg-white font-semibold text-indigo-700 hover:bg-indigo-100 dark:border-indigo-800 dark:bg-slate-950 dark:text-indigo-300 dark:hover:bg-indigo-950/50"
                    >
                      <Send className={cn("mr-2 h-4 w-4", isSendingTokenEmail && "animate-pulse")} />
                      {isSendingTokenEmail ? "Sending Token..." : "Send Token to Admin"}
                    </Button>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      Provide this security token to the Super Admin to mark this order as fulfilled.
                    </p>
                  </div>
                </section>
              )}
             
            </div>
          )}

          <DialogFooter>
            <Button onClick={() => setShowOrderDetail(false)}>Close</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
