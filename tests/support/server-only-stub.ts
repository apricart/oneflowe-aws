/**
 * Test stand-in for the `server-only` package.
 *
 * The real package throws the moment it is imported outside a React Server
 * Component, which means a test can never import anything under `lib/server/`.
 * That is why the suite historically asserted on file *text* instead of calling
 * the code. Aliasing the package to this empty module in the Vitest configs
 * lets tests import and run server modules directly, while the real package
 * still guards the application build — the alias exists only under Vitest.
 */
export {}
