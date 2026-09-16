export function isValidEmailAddress(email: string): boolean {
  const atIndex = email.indexOf("@")
  const dotIndex = email.lastIndexOf(".")
  const hasWhitespace = Array.from(email).some((character) => character.trim() === "")

  return atIndex > 0
    && atIndex === email.lastIndexOf("@")
    && dotIndex > atIndex + 1
    && dotIndex < email.length - 1
    && !hasWhitespace
}

/**
 * Whether mail sent to this address can reach anyone. `.invalid` is reserved
 * by RFC 2606 and never routes; the K-Electric sync derives such addresses
 * (`ke-legacy.invalid`, `historical.invalid`) for people the legacy platform
 * holds no email for, and a verification code sent there is a lockout.
 */
export function isRoutableEmailAddress(email: string): boolean {
  if (!isValidEmailAddress(email)) return false
  const domain = email.slice(email.lastIndexOf("@") + 1).toLowerCase()
  return domain !== "invalid" && !domain.endsWith(".invalid")
}

/**
 * `imrank@ke.com.pk` → `i***@ke.com.pk`. Enough for the person to recognise
 * the mailbox, not enough for the next person at a shared branch PC to read
 * it off the screen.
 */
export function maskEmailAddress(email: string): string {
  const atIndex = email.indexOf("@")
  if (atIndex <= 0) return "***"
  return `${email.slice(0, 1)}***${email.slice(atIndex)}`
}
