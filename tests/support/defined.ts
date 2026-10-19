export function defined<T>(value: T, description: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`Expected ${description}`);

  return value;
}
