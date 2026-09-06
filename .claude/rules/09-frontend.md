# 09 — Frontend (React / Next.js App Router)

No equivalent in the source standard, which assumed a Python backend. These
rules exist because in a Next.js application a large share of the security and
correctness surface lives in the client/server boundary.

## Server / client boundary

- **Nothing secret crosses to the client.** Only `NEXT_PUBLIC_*` environment
  variables are safe in client code. Anything else in a component that carries
  `"use client"` — directly or transitively — ships to the browser.
- Server-only modules import `server-only`. Keep them under `lib/server/`.
- A Server Action is a public HTTP endpoint. It authenticates, authorizes,
  validates, and scopes exactly like a route handler (rule 05). An unguarded
  Server Action is an unauthenticated API.
- Do not pass a whole database row into a client component as a prop because it
  is convenient. Props to client components are visible in the page payload —
  select the fields the UI needs.

## Rendering and data

- Data fetching in this app happens in client components via `lib/hooks/` and
  `lib/api.ts` (SWR). Follow that pattern rather than introducing a second one.
- Handle the three states explicitly: loading, empty, and error. An error state
  shows the message from `lib/error-handler.ts`, never a raw exception.
- Respect the React Hooks rules; `eslint-plugin-react-hooks` is enforced. A
  dependency array is not padded to silence a warning — fix the dependency.
- Keys in lists are stable ids, never array indices, on any list that reorders
  or filters.
- Guard against double submission on every mutating control — a disabled button
  during flight, and idempotency on the server (rule 05).

## Authorization in the UI

- Hiding a control is presentation, not authorization. The server check in the
  route handler is the control (rule 04).
- Permission checks in the UI read from `lib/permissions.ts` — never an inline
  `role === "SUPER_ADMIN"` comparison in a component.
- Price visibility follows `lib/price-visibility.ts`. Do not fetch a price the
  role may not see and then hide it client-side; it is in the payload.

## Rendering untrusted content

- `dangerouslySetInnerHTML` needs a documented reason and sanitization.
- Validate the scheme before putting user-supplied values into `href` or `src`
  (`javascript:`, `data:`).
- Image sources are application paths from `lib/server/image-storage.ts`.

## Components

- Follow `components/` feature-domain organisation; shadcn/ui primitives stay in
  `components/ui/` and are not modified ad hoc.
- Shared state goes through the existing providers in `components/context/`.
- Business rules do not live in components. They live in `lib/`, where they can
  be tested (rule 01).

## Accessibility and UX baseline

Labelled form controls, keyboard-reachable interactive elements, visible focus,
and an error message tied to its field. Do not regress these when restyling.
