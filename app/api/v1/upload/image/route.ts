import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth-options"
import { sanitizeRasterUpload } from "@/lib/server/upload-security"
import { withRateLimit } from "@/lib/rate-limiter"

export async function POST(req: NextRequest) {
  try {
    const session = await getServerSession(authOptions)
    if (!session?.user) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const userRole = (session.user as any).role
    if (userRole !== "SUPER_ADMIN") {
      return NextResponse.json({ error: "Forbidden - Super Admin access required" }, { status: 403 })
    }

    const rateLimit = await withRateLimit("upload", (session.user as any).id)
    if (rateLimit) return rateLimit

    const formData = await req.formData()
    const file = formData.get("image")

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: "No image file provided" }, { status: 400 })
    }

    const bytes = await file.arrayBuffer()
    const buffer = Buffer.from(bytes)
    const validation = await sanitizeRasterUpload({
      buffer,
      declaredMime: file.type,
    })
    if (!validation.ok) {
      return NextResponse.json({ error: validation.error }, { status: 400 })
    }

    const base64Image = validation.buffer.toString('base64')
    const dataUrl = `data:${validation.image.mime};base64,${base64Image}`

    return NextResponse.json({
      url: dataUrl,
      fileName: validation.generatedFileName,
      size: validation.buffer.length,
      type: validation.image.mime,
      width: validation.image.width,
      height: validation.image.height,
    })

  } catch (error: any) {
    console.error("Critical Upload Error:", error)
    return NextResponse.json({
      error: "Internal Server Error",
      details: "Upload failed"
    }, { status: 500 })
  }
}
