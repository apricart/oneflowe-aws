import { parseEdgeEnv } from './env-validation'

/**
 * The request proxy cannot import `server-only`.
 * Keep this boundary minimal: it exposes only the secret required to verify
 * NextAuth JWTs and is imported only by proxy.ts.
 */
export const edgeEnv = parseEdgeEnv(process.env)

