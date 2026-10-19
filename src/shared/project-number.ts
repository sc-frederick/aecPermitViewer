export const PROJECT_NUMBER_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9 ._/-]*)?$/;

export const PROJECT_NUMBER_MAX = 40;

export function projectProblem(value: string): string | null {
  if (value.length > PROJECT_NUMBER_MAX) return `Use ${PROJECT_NUMBER_MAX} characters or fewer.`;

  return PROJECT_NUMBER_PATTERN.test(value) ? null : "Use letters, numbers, spaces, and - . _ / only.";
}
