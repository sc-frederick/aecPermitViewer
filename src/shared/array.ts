export function onlyElement<T>(items: readonly T[]): T | null {
  const [only, ...others] = items;

  return only !== undefined && others.length === 0 ? only : null;
}
