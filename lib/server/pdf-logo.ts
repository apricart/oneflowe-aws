import fs from "node:fs"
import path from "node:path"

/**
 * The Apricart logo as a data URL for jsPDF, or null when the file cannot be
 * read (the caller then prints the name instead). Shared by every server-built
 * PDF so the invoice and the consolidated invoice carry the same mark.
 */
export function apricartLogoDataUrl(): string | null {
  try {
    const logoPath = path.join(process.cwd(), "public", "apricart-logo-blue.png")
    if (!fs.existsSync(logoPath)) return null
    return `data:image/png;base64,${fs.readFileSync(logoPath).toString("base64")}`
  } catch {
    return null
  }
}
