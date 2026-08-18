export function SessionUnavailable() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-slate-950 px-6 text-center text-white">
      <div className="max-w-md rounded-xl border border-slate-700 bg-slate-900 p-6 shadow-2xl">
        <h1 className="text-lg font-semibold">Session verification unavailable</h1>
        <p className="mt-2 text-sm text-slate-300">
          Protected content is locked while the server verifies your session. Please retry shortly.
        </p>
      </div>
    </main>
  )
}
