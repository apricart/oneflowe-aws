"use client"
import React from "react"
import { AlertTriangle, AlertCircle, CheckCircle, Info, X } from "lucide-react"
import { Button } from "@/components/ui/button"

export type ErrorType = "error" | "warning" | "info" | "success"

interface ErrorDisplayProps {
  type?: ErrorType
  title?: string
  message: string
  details?: string
  onDismiss?: () => void
  onRetry?: () => void
  actions?: {
    label: string
    onClick: () => void
    variant?: "default" | "destructive" | "outline"
  }[]
}

export function ErrorDisplay({
  type = "error",
  title,
  message,
  details,
  onDismiss,
  onRetry,
  actions = [],
}: Readonly<ErrorDisplayProps>) {
  const getStyles = () => {
    const styles = {
      error: {
        bg: "bg-red-50 dark:bg-red-950",
        border: "border-red-200 dark:border-red-800",
        icon: "text-red-600 dark:text-red-400",
        title: "text-red-900 dark:text-red-100",
        text: "text-red-700 dark:text-red-300",
      },
      warning: {
        bg: "bg-yellow-50 dark:bg-yellow-950",
        border: "border-yellow-200 dark:border-yellow-800",
        icon: "text-yellow-600 dark:text-yellow-400",
        title: "text-yellow-900 dark:text-yellow-100",
        text: "text-yellow-700 dark:text-yellow-300",
      },
      info: {
        bg: "bg-blue-50 dark:bg-blue-950",
        border: "border-blue-200 dark:border-blue-800",
        icon: "text-blue-600 dark:text-blue-400",
        title: "text-blue-900 dark:text-blue-100",
        text: "text-blue-700 dark:text-blue-300",
      },
      success: {
        bg: "bg-green-50 dark:bg-green-950",
        border: "border-green-200 dark:border-green-800",
        icon: "text-green-600 dark:text-green-400",
        title: "text-green-900 dark:text-green-100",
        text: "text-green-700 dark:text-green-300",
      },
    }
    return styles[type]
  }

  const getIcon = () => {
    const icons = {
      error: AlertTriangle,
      warning: AlertCircle,
      info: Info,
      success: CheckCircle,
    }
    return icons[type]
  }

  const Icon = getIcon()
  const styles = getStyles()

  return (
    <div className={`p-4 rounded-lg border ${styles.bg} ${styles.border} space-y-3`}>
      <div className="flex items-start gap-3">
        <Icon className={`h-5 w-5 flex-shrink-0 mt-0.5 ${styles.icon}`} />
        <div className="flex-1 min-w-0">
          {title && (
            <h3 className={`font-semibold ${styles.title}`}>
              {title}
            </h3>
          )}
          <p className={`text-sm ${styles.text}`}>
            {message}
          </p>
          {details && (
            <details className="mt-2">
              <summary className={`text-xs cursor-pointer hover:underline ${styles.text}`}>
                More details
              </summary>
              <pre className={`mt-2 text-xs overflow-auto max-h-32 p-2 bg-black/10 rounded ${styles.text} font-mono`}>
                {details}
              </pre>
            </details>
          )}
        </div>
        {onDismiss && (
          <Button
            onClick={onDismiss}
            variant="ghost"
            size="icon"
            className="h-5 w-5 flex-shrink-0 -mt-1"
          >
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {(onRetry || actions.length > 0) && (
        <div className="flex gap-2 pt-2 border-t border-current/10">
          {onRetry && (
            <Button
              onClick={onRetry}
              size="sm"
              variant="outline"
              className="text-xs"
            >
              Retry
            </Button>
          )}
          {actions.map((action) => (
            <Button
              key={action.label}
              onClick={action.onClick}
              size="sm"
              variant={action.variant || "outline"}
              className="text-xs"
            >
              {action.label}
            </Button>
          ))}
        </div>
      )}
    </div>
  )
}
