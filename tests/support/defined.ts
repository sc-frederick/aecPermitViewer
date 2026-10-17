/**
 * Unwraps a value the test's setup guarantees.
 *
 * @param description - What the value is; the error reads "Expected <description>".
 * @returns The value, narrowed to exclude null and undefined.
 * @throws Error when the value is null or undefined, which fails the calling test.
 */
export function defined<T>(value: T, description: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`Expected ${description}`);

  return value;
}
