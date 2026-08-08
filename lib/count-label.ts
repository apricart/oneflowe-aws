/**
 * Formats a numeric count with the correct English singular or plural label.
 *
 * Pass an explicit plural for words that cannot be pluralized by adding "s".
 */
export function formatCountLabel(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  const label = count === 1 ? singular : plural
  return `${count.toLocaleString()} ${label}`
}
