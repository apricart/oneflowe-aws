/**
 * Converts values that are safe and meaningful as text without falling back to
 * JavaScript's unhelpful "[object Object]" representation.
 */
export function stringifyPrimitive(value: unknown): string {
    if (typeof value === "string") {
        return value
    }
    if (
        typeof value === "number"
        || typeof value === "boolean"
        || typeof value === "bigint"
    ) {
        return String(value)
    }
    if (value instanceof Date) {
        return value.toISOString()
    }
    return ""
}
