import type { PermitRow } from "./permit.js";

/** Permits that share one project number, compared by `projectKey`. */
export interface ProjectGroup {
  /** Null holds the permits without a project number. */
  projectNumber: string | null;
  permits: PermitRow[];
}

/** A project number: a letter or digit, then letters, digits, spaces, and - . _ /. Empty clears it. */
export const PROJECT_NUMBER_PATTERN = /^(?:[A-Za-z0-9][A-Za-z0-9 ._/-]*)?$/;

/** The longest project number accepted, in characters. */
export const PROJECT_NUMBER_MAX = 40;

/** Returns the reason a trimmed project number can't be saved, or null when it can. An empty value clears it. */
export function projectProblem(value: string): string | null {
  if (value.length > PROJECT_NUMBER_MAX) return `Use ${PROJECT_NUMBER_MAX} characters or fewer.`;

  return PROJECT_NUMBER_PATTERN.test(value) ? null : "Use letters, numbers, spaces, and - . _ / only.";
}

const projectOrder = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/** Grouping key for a project number: case-insensitive, ignoring leading and trailing spaces. */
export function projectKey(projectNumber: string): string {
  return projectNumber.trim().toLocaleUpperCase("en-US");
}

/**
 * Groups permits by project number, in natural order ("2807" before "28069"), with permits that have
 * no project last. Permits keep their incoming order within a group.
 */
export function groupByProject(permits: readonly PermitRow[]): ProjectGroup[] {
  const groups = new Map<string, { projectNumber: string; permits: PermitRow[] }>();
  const unassigned: PermitRow[] = [];

  for (const permit of permits) {
    const number = permit.projectNumber?.trim();

    if (!number) {
      unassigned.push(permit);
      continue;
    }

    const key = projectKey(number);
    const group = groups.get(key);

    if (group) group.permits.push(permit);
    else groups.set(key, { projectNumber: number, permits: [permit] });
  }

  const sorted = [...groups.values()].sort((a, b) => projectOrder.compare(a.projectNumber, b.projectNumber));

  return unassigned.length > 0 ? [...sorted, { projectNumber: null, permits: unassigned }] : sorted;
}

/**
 * Up to `limit` distinct project numbers, in the order of `permits`; given the window's newest-first list, the most
 * recently added come first.
 */
export function recentProjects(permits: readonly PermitRow[], limit: number): string[] {
  const seen = new Map<string, string>();

  for (const permit of permits) {
    const number = permit.projectNumber?.trim();

    if (number && !seen.has(projectKey(number))) seen.set(projectKey(number), number);
  }

  return [...seen.values()].slice(0, limit);
}
