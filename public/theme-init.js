(function () {
  try {
    const theme = localStorage.getItem("theme") || "system"
    const isDark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)

    document.documentElement.classList.toggle("dark", isDark)
  } catch (error) {
    // Theme initialization is best-effort only.
    console.warn("Unable to initialize the saved theme:", error)
  }
})()
