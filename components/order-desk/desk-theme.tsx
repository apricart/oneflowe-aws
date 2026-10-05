import { CheckCircle2, Clock, Mail, MessageCircle, MoreHorizontal, PackageCheck, Phone, XCircle } from "lucide-react"

import type { IntakeChannel } from "@/lib/order-desk-access"
import type { DeskOrderStage, DeskOrderStatusFilter } from "@/lib/order-desk-query"

/** Any icon from the set above; every lucide icon shares this component type. */
type LucideIcon = typeof Clock

/**
 * The Order Desk's colours, in one place so every screen says the same thing
 * the same way. Deliberately few: one accent (indigo) for "this is yours to
 * act on", and one colour per stage of an order —
 *
 *   amber   waiting on Super Admin to record delivery
 *   indigo  delivered, ready for the desk to fulfil
 *   emerald done
 *   slate   cancelled
 *
 * Colour is never the only signal: every stage also carries its words and an
 * icon.
 */
export type StageMeta = {
  label: string
  hint: string
  icon: LucideIcon
  /** The dot on a tab and the tracker. */
  dot: string
  /** A soft pill: tinted background, coloured text. */
  pill: string
}

export const STAGE_META: Record<DeskOrderStage, StageMeta> = {
  awaiting_delivery: {
    label: "Awaiting delivery",
    hint: "Super Admin records delivery. You can still edit or cancel.",
    icon: Clock,
    dot: "bg-amber-500",
    pill: "bg-amber-50 text-amber-800 ring-amber-200 dark:bg-amber-950/40 dark:text-amber-200 dark:ring-amber-900",
  },
  ready_to_fulfil: {
    label: "Ready to fulfil",
    hint: "Delivered. Confirm the customer received it and fulfil.",
    icon: PackageCheck,
    dot: "bg-indigo-500",
    pill: "bg-indigo-50 text-indigo-800 ring-indigo-200 dark:bg-indigo-950/40 dark:text-indigo-200 dark:ring-indigo-900",
  },
  fulfilled: {
    label: "Fulfilled",
    hint: "Complete. A refund can be requested if needed.",
    icon: CheckCircle2,
    dot: "bg-emerald-500",
    pill: "bg-emerald-50 text-emerald-800 ring-emerald-200 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  },
  cancelled: {
    label: "Cancelled",
    hint: "Withdrawn before delivery. Stock and budget were released.",
    icon: XCircle,
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
  other: {
    label: "Other",
    hint: "",
    icon: MoreHorizontal,
    dot: "bg-slate-400",
    pill: "bg-slate-100 text-slate-700 ring-slate-200 dark:bg-slate-800 dark:text-slate-300 dark:ring-slate-700",
  },
}

export const TAB_LABELS: Record<DeskOrderStatusFilter, string> = {
  awaiting_delivery: STAGE_META.awaiting_delivery.label,
  ready_to_fulfil: STAGE_META.ready_to_fulfil.label,
  fulfilled: STAGE_META.fulfilled.label,
  cancelled: STAGE_META.cancelled.label,
  all: "All orders",
}

export const CHANNEL_META: Record<IntakeChannel, { label: string; icon: LucideIcon; tone: string; selected: string }> = {
  WHATSAPP: {
    label: "WhatsApp",
    icon: MessageCircle,
    tone: "text-emerald-700 dark:text-emerald-300",
    selected: "border-emerald-500 bg-emerald-50 text-emerald-800 ring-2 ring-emerald-100 dark:bg-emerald-950/40 dark:text-emerald-200 dark:ring-emerald-900",
  },
  EMAIL: {
    label: "Email",
    icon: Mail,
    tone: "text-sky-700 dark:text-sky-300",
    selected: "border-sky-500 bg-sky-50 text-sky-800 ring-2 ring-sky-100 dark:bg-sky-950/40 dark:text-sky-200 dark:ring-sky-900",
  },
  PHONE: {
    label: "Phone",
    icon: Phone,
    tone: "text-violet-700 dark:text-violet-300",
    selected: "border-violet-500 bg-violet-50 text-violet-800 ring-2 ring-violet-100 dark:bg-violet-950/40 dark:text-violet-200 dark:ring-violet-900",
  },
  OTHER: {
    label: "Other",
    icon: MoreHorizontal,
    tone: "text-slate-600 dark:text-slate-300",
    selected: "border-slate-500 bg-slate-100 text-slate-800 ring-2 ring-slate-200 dark:bg-slate-800 dark:text-slate-200 dark:ring-slate-700",
  },
}

export function StagePill({ stage }: Readonly<{ stage: DeskOrderStage }>) {
  const meta = STAGE_META[stage]
  const Icon = meta.icon
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset ${meta.pill}`}>
      <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      {meta.label}
    </span>
  )
}

/** A numbered section heading, so the new-order form reads as three steps. */
export function StepHeading({
  number,
  title,
  description,
  done = false,
}: Readonly<{ number: number; title: string; description: string; done?: boolean }>) {
  return (
    <div className="flex items-start gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
          done
            ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300"
            : "bg-indigo-100 text-indigo-700 dark:bg-indigo-950 dark:text-indigo-300"
        }`}
        aria-hidden="true"
      >
        {done ? <CheckCircle2 className="h-4 w-4" /> : number}
      </span>
      <div>
        <h2 className="text-base font-semibold text-slate-900 dark:text-white">{title}</h2>
        <p className="text-sm text-muted-foreground">{description}</p>
      </div>
    </div>
  )
}
