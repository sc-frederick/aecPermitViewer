import type { PermitRow } from "./permit.js";

export interface ProjectGroup {
  projectNumber: string | null;
  permits: PermitRow[];
}

const projectOrder = new Intl.Collator("en-US", { numeric: true, sensitivity: "base" });

export function projectKey(projectNumber: string): string {
  return projectNumber.trim().toLocaleUpperCase("en-US");
}

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

export function recentProjects(permits: readonly PermitRow[], limit: number): string[] {
  const seen = new Map<string, string>();

  for (const permit of permits) {
    const number = permit.projectNumber?.trim();

    if (number && !seen.has(projectKey(number))) seen.set(projectKey(number), number);
  }

  return [...seen.values()].slice(0, limit);
}
