import { describe, expect, it } from "vitest";
import { groupByProject, recentProjects } from "../src/shared/projects.js";
import { projectNumberSchema, type PermitRow } from "../src/shared/permit.js";

function permit(id: string, projectNumber: string | null): PermitRow {
  return {
    id,
    jurisdictionId: "hillsborough-county-building",
    permitNumber: id,
    projectNumber,
    reviews: null,
    monitoringEnabled: true,
    lastStatus: null,
    lastObservedAt: null,
    lastRecordUrl: null,
    latestAttemptAt: null,
    latestOutcome: null,
    nextDueAt: null,
    checking: false,
  };
}

describe("project groups", () => {
  it("orders projects naturally, keeps permit order, and puts permits without a project last", () => {
    const groups = groupByProject([
      permit("a", "28069"),
      permit("b", null),
      permit("c", "2807"),
      permit("d", "28069"),
      permit("e", "  "),
    ]);

    expect(groups.map((group) => [group.projectNumber, group.permits.map((entry) => entry.id)])).toEqual([
      ["2807", ["c"]],
      ["28069", ["a", "d"]],
      [null, ["b", "e"]],
    ]);
  });

  it("treats case and surrounding spaces as the same project", () => {
    const groups = groupByProject([permit("a", "job-12"), permit("b", " JOB-12 ")]);
    expect(groups.map((group) => group.permits.length)).toEqual([2]);
  });

  it("lists distinct recent projects, newest permit first", () => {
    expect(
      recentProjects([permit("a", "3"), permit("b", null), permit("c", "1"), permit("d", "3"), permit("e", "2")], 2),
    ).toEqual(["3", "1"]);
  });

  it("accepts common job number formats and rejects control characters", () => {
    for (const value of ["28069", "2024-117.02", "AEC 28069", "J/1234", ""])
      expect(projectNumberSchema.safeParse(value).success).toBe(true);

    for (const value of ["-28069", "280\t69", "x".repeat(41), "<b>"])
      expect(projectNumberSchema.safeParse(value).success).toBe(false);
  });
});
