import { parseEdgeEnv } from './env-validation'

/**
 * Middleware runs on the Edge runtime and cannot import `server-only`.
 * Keep this boundary minimal: it exposes only the secret required to verify
 * NextAuth JWTs and is imported only by middleware.ts.
 */
export const edgeEnv = parseEdgeEnv(process.env)

