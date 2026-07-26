import bcrypt from 'bcryptjs'
import { randomInt } from 'node:crypto'

import { passwordToolEnv } from '@/lib/server/password-tool-env'

const MIN_PASSWORD_LENGTH = 12
const MAX_PASSWORD_LENGTH = 128

export function generateImportPassword(length = 20): string {
  const safeLength = Number.isInteger(length) && length >= MIN_PASSWORD_LENGTH && length <= MAX_PASSWORD_LENGTH
    ? length
    : 20
  const groups = [
    'abcdefghijklmnopqrstuvwxyz',
    'ABCDEFGHIJKLMNOPQRSTUVWXYZ',
    '0123456789',
    '!@#$%^&*()_+-=[]{}|;:,.<>?',
  ]
  const allCharacters = groups.join('')
  const characters = groups.map((group) => group[randomInt(group.length)])

  while (characters.length < safeLength) {
    characters.push(allCharacters[randomInt(allCharacters.length)])
  }
  for (let index = characters.length - 1; index > 0; index--) {
    const target = randomInt(index + 1)
    ;[characters[index], characters[target]] = [characters[target], characters[index]]
  }
  return characters.join('')
}

export async function hashImportPassword(password: string): Promise<string> {
  if (password.length < MIN_PASSWORD_LENGTH || password.length > MAX_PASSWORD_LENGTH) {
    throw new Error('Password must be 12 to 128 characters.')
  }
  if (!/[A-Z]/.test(password) || !/[a-z]/.test(password) || !/\d/.test(password) || !/[^a-zA-Z0-9]/.test(password)) {
    throw new Error('Password must include upper/lowercase letters, a number, and a special character.')
  }
  return bcrypt.hash(password, passwordToolEnv.BCRYPT_ROUNDS)
}
