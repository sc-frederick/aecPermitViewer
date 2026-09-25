import type { PermitRow } from "./permit.js";

export interface ProjectGroup {
  /** Null holds the permits without a project number. */
  projectNumber: string | null;
  permits: PermitRow[];
}

const projectOrder = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

/** The same project typed in a different case or with stray spaces is one group. */
export function projectKey(projectNumber: string): string {
  return projectNumber.trim().toLocaleUpperCase("en-US");
}

/**
 * Groups permits by project number, in natural order ("2807" before "28069"), with permits that have
 * no project last. Permits keep their incoming order within a group.
 */
export function groupByProject(permits: readonly PermitRow[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  const unassigned: PermitRow[] = [];
  for (const permit of permits) {
    const number = permit.projectNumber?.trim();
    if (!number) { unassigned.push(permit); continue; }
    const key = projectKey(number);
    const group = groups.get(key);
    if (group) group.permits.push(permit); else groups.set(key, { projectNumber: number, permits: [permit] });
  }
  const sorted = [...groups.values()].sort((a, b) => projectOrder.compare(a.projectNumber!, b.projectNumber!));
  return unassigned.length > 0 ? [...sorted, { projectNumber: null, permits: unassigned }] : sorted;
}

/** Distinct project numbers already in use, most recently added permit first. */
export function recentProjects(permits: readonly PermitRow[], limit: number): string[] {
  const seen = new Map<string, string>();
  for (const permit of permits) {
    const number = permit.projectNumber?.trim();
    if (number && !seen.has(projectKey(number))) seen.set(projectKey(number), number);
  }
  return [...seen.values()].slice(0, limit);
}
