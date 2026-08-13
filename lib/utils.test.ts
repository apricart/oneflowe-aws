
import { describe, it, expect } from 'vitest'
import {
    cn,
    formatPKR,
    escapeLikePattern,
    sanitizeInput,
    safeJsonParse,
    safeParseInt,
    safeParseFloat,
    formatDate,
    clamp,
    truncate
} from './utils'

describe('cn', () => {
    it('merges classes correctly', () => {
        expect(cn('c1', 'c2')).toBe('c1 c2')
        expect(cn('c1', { c2: true, c3: false })).toBe('c1 c2')
    })

    it('handles tailwind conflicts', () => {
        expect(cn('p-4', 'p-2')).toBe('p-2')
    })
})

describe('formatPKR', () => {
    it('formats number to PKR currency', () => {
        // Note: Exact spacing/symbol might depend on locale implementation in node/jsdom
        const result = formatPKR(1000)
        // Matches PKR or Rs
        expect(result).toMatch(/(PKR|Rs)\s?1,000/)
    })

    it('handles invalid input', () => {
        expect(formatPKR(NaN)).toBe('PKR 0.00')
        // @ts-expect-error intentional invalid input for runtime guard
        expect(formatPKR('invalid')).toBe('PKR 0.00')
    })
})

describe('escapeLikePattern', () => {
    it('escapes special characters', () => {
        expect(escapeLikePattern('100%')).toBe('100\\%')
        expect(escapeLikePattern('user_name')).toBe('user\\_name')
    })
})

describe('sanitizeInput', () => {
    it('removes null bytes and trims', () => {
        expect(sanitizeInput('  hello\0world  ')).toBe('helloworld')
    })

    it('truncates long input', () => {
        const longString = 'a'.repeat(10005)
        expect(sanitizeInput(longString)).toHaveLength(10000)
    })
})

describe('safeParsers', () => {
    it('safeParseInt handles valid and invalid input', () => {
        expect(safeParseInt('123')).toBe(123)
        expect(safeParseInt('abc', 10)).toBe(10)
    })

    it('safeParseFloat handles valid and invalid input', () => {
        expect(safeParseFloat('12.34')).toBe(12.34)
        expect(safeParseFloat('abc', 1.5)).toBe(1.5)
    })

    it('safeJsonParse parses valid json', () => {
        expect(safeJsonParse('{"a":1}')).toEqual({ a: 1 })
    })

    it('safeJsonParse returns null on invalid json', () => {
        expect(safeJsonParse('{invalid}')).toBeNull()
    })
})

describe('formatDate', () => {
    it('formats valid date', () => {
        const date = new Date('2023-01-01')
        expect(formatDate(date)).toContain('January 1, 2023')
    })

    it('handles invalid date', () => {
        expect(formatDate('invalid')).toBe('Invalid Date')
    })
})

describe('clamp', () => {
    it('clamps value within range', () => {
        expect(clamp(5, 0, 10)).toBe(5)
        expect(clamp(-5, 0, 10)).toBe(0)
        expect(clamp(15, 0, 10)).toBe(10)
    })
})

describe('truncate', () => {
    it('truncates string with suffix', () => {
        expect(truncate('hello world', 5)).toBe('he...')
    })

    it('returns original string if short enough', () => {
        expect(truncate('hello', 10)).toBe('hello')
    })
})
