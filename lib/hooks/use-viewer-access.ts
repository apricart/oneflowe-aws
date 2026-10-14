"use client"

import { useSession } from "next-auth/react"

import { viewerAccessFor } from "@/lib/viewer-access"

export type ViewerAccess = {
  /** The signed-in role, unchanged. */
  role: string | null
  /**
   * The role a shared page renders its view for. An organization-wide Viewer
   * sees Head Office's pages, so it gets `HEAD_OFFICE`; everyone else, itself.
   * Choose a *view* with it, never a permission.
   */
  viewRole: string | null
  /** True when the account may change nothing: hide every write control. */
  readOnly: boolean
}

/**
 * How a page should treat the signed-in user's role. Presentation only — every
 * endpoint behind the page decides what the caller may read and refuses the
 * Viewer every write on its own (`lib/viewer-access.ts`).
 */
export function useViewerAccess(): ViewerAccess {
  return viewerAccessFor(useSession().data?.user)
}
