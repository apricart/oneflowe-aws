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
