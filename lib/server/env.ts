import 'server-only'

import { parseServerEnv } from './env-validation'

/**
 * Validated configuration for the normal Next.js server runtime.
 * Migration and administrator-bootstrap credentials deliberately live in
 * separate, CLI-only modules and are never exported here.
 */
export const env = parseServerEnv(process.env)

