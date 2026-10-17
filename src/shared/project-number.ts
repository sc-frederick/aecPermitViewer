/** A project number: a letter or digit, then letters, digits, spaces, and - . _ /. Empty clears it. */
export const PROJECT_NUMBER_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9 ._/-]*)?$/;

/** The longest project number accepted, in characters. */
export const PROJECT_NUMBER_MAX = 40;

/** Returns the reason a trimmed project number can't be saved, or null when it can. An empty value clears it. */
export function projectProblem(value: string): string | null {
  if (value.length > PROJECT_NUMBER_MAX) return `Use ${PROJECT_NUMBER_MAX} characters or fewer.`;

  return PROJECT_NUMBER_PATTERN.test(value) ? null : "Use letters, numbers, spaces, and - . _ / only.";
}
