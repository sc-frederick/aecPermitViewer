/**
 * The sole element of a list that must identify exactly one item, such as the one search result matching a
 * requested number.
 *
 * @param items - The candidates.
 * @returns The element when `items` has exactly one; null when it is empty or ambiguous.
 */
export function onlyElement<T>(items: readonly T[]): T | null {
  const [only, ...others] = items;

  return only !== undefined && others.length === 0 ? only : null;
}
