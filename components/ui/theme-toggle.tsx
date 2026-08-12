"use client"
import { useEffect, useState } from "react"
import { Button } from "@/components/ui/button"
import { Moon, Sun } from "lucide-react"

const THEME_KEY = "oneflowe:theme" // "light" | "dark" | "system"

function applyTheme(next: string) {
  const root = document.documentElement
  const isDark =
    next === "dark" ||
    (next === "system" && window.matchMedia?.("(prefers-color-scheme: dark)").matches)
  root.classList.toggle("dark", isDark)
}

export function ThemeToggle() {
  const [theme, setTheme] = useState<string>("system")

  useEffect(() => {
    const persisted = localStorage.getItem(THEME_KEY) || "system"
    setTheme(persisted)
    applyTheme(persisted)
  }, [])

  function cycle() {
    const next = (() => {
      if (theme === "light") {
        return "dark"
      }
      if (theme === "dark") {
        return "system"
      }
      return "light"
    })()
    setTheme(next)
    localStorage.setItem(THEME_KEY, next)
    applyTheme(next)
  }

  const icon = theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />
  const label = (() => {
    if (theme === "system") {
      return "System"
    }
    if (theme === "dark") {
      return "Dark"
    }
    return "Light"
  })()

  return (
    <Button variant="ghost" size="sm" onClick={cycle} aria-label="Toggle theme" title={`Theme: ${label}`}>
      {icon}
      <span className="ml-2 hidden md:inline">{label}</span>
    </Button>
  )
}
