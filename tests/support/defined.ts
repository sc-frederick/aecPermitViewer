/**
 * Unwrap a value the test's setup guarantees, failing the test with a clear message when it is missing.
 *
 * @param value - The value the test expects to be present.
 * @param description - What the value is, completing "Expected ...".
 * @returns The value, narrowed to exclude null and undefined.
 * @throws Error when the value is null or undefined, which fails the calling test.
 */
export function defined<T>(value: T, description: string): NonNullable<T> {
  if (value === null || value === undefined) throw new Error(`Expected ${description}`);

  return value;
}
