(function () {
  try {
    var theme = localStorage.getItem("theme") || "system"
    var isDark =
      theme === "dark" ||
      (theme === "system" &&
        window.matchMedia("(prefers-color-scheme: dark)").matches)

    document.documentElement.classList.toggle("dark", isDark)
  } catch (_) {
    // Theme initialization is best-effort only.
  }
})()
