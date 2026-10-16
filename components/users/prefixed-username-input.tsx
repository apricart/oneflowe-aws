"use client"

import type { ComponentProps } from "react"

import { Input } from "@/components/ui/input"
import { USERNAME_BASE_MAX_LENGTH, USERNAME_PREFIX_SEPARATOR } from "@/lib/username-prefix"
import { cn } from "@/lib/utils"

/**
 * A username box with the organization's prefix fixed in front of it
 * (plans/OF-USERS-organization-username-prefix.md). The prefix is shown, not
 * typed: the server adds it from the organization's own row whatever is sent.
 * With no prefix (an account with no organization) it is a plain input.
 */
export function PrefixedUsernameInput({
  prefix,
  className,
  ...inputProps
}: Readonly<{ prefix: string } & Omit<ComponentProps<typeof Input>, "maxLength">>) {
  if (!prefix) return <Input maxLength={USERNAME_BASE_MAX_LENGTH} className={className} {...inputProps} />
  const prefixId = inputProps.id ? `${inputProps.id}-prefix` : undefined
  const describedBy = [prefixId, inputProps["aria-describedby"]].filter(Boolean).join(" ") || undefined
  return (
    <div className="flex">
      <span
        id={prefixId}
        className="inline-flex shrink-0 items-center rounded-l-md border border-r-0 border-slate-300 bg-slate-100 px-3 font-mono text-sm font-medium text-slate-700"
        title="Your organization's username prefix"
      >
        {prefix}{USERNAME_PREFIX_SEPARATOR}
      </span>
      <Input
        maxLength={USERNAME_BASE_MAX_LENGTH}
        autoCapitalize="none"
        spellCheck={false}
        {...inputProps}
        aria-describedby={describedBy}
        className={cn("min-w-0 rounded-l-none", className)}
      />
    </div>
  )
}
