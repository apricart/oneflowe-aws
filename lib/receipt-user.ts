export type ReceiptUserIdentity = {
  fullName?: string | null
  firstName?: string | null
  lastName?: string | null
  username?: string | null
  email?: string | null
}

export function getReceiptUserDisplayName(
  user: ReceiptUserIdentity | null | undefined,
  fallback: string,
): string {
  if (!user) return fallback

  const fullName = user.fullName?.trim()
  if (fullName) return fullName

  const combinedName = [user.firstName, user.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ")
  if (combinedName) return combinedName

  return user.username?.trim() || user.email?.trim() || fallback
}
