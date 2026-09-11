import { notFound } from "next/navigation"

import { SupportThreadView } from "@/components/support/support-thread-view"

export default async function SupportThreadPage({
  params,
}: Readonly<{ params: Promise<{ id: string }> }>) {
  const { id } = await params
  const threadId = Number(id)

  if (!Number.isInteger(threadId) || threadId <= 0) notFound()

  return <SupportThreadView threadId={threadId} />
}
