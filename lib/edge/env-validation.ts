const PLACEHOLDERS = new Set([
  'admin123',
  'change-me',
  'changeme',
  'default',
  'dummy',
  'example',
  'null',
  'password',
  'password123',
  'replace-me',
  'secret',
  'todo',
  'undefined',
  'your-password-here',
  'your-secret',
])

export function parseEdgeEnv(values: Record<string, string | undefined>) {
  const value = values.NEXTAUTH_SECRET?.trim()
  const normalized = value?.toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-')

  if (!value) {
    throw new Error('Invalid Edge environment configuration: NEXTAUTH_SECRET is required')
  }
  if (PLACEHOLDERS.has(normalized ?? '')) {
    throw new Error('Invalid Edge environment configuration: NEXTAUTH_SECRET is a placeholder')
  }
  if (value.length < 32) {
    throw new Error(
      'Invalid Edge environment configuration: NEXTAUTH_SECRET must contain at least 32 characters',
    )
  }

  return Object.freeze({ NEXTAUTH_SECRET: value })
}

