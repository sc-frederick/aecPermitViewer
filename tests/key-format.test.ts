import { describe, expect, it } from "vitest";
import { keyProblem } from "../src/shared/key-format.js";

describe("TypeSafe key format", () => {
  it("accepts a pasted key", () => {
    expect(keyProblem("ts_live_4f8c1d2e9a7b6c5d")).toBeNull();
  });

  it("rejects empty, truncated, and multi-line input", () => {
    expect(keyProblem("")).toMatch(/Enter/);
    expect(keyProblem("abc")).toMatch(/incomplete/);
    expect(keyProblem("ts_live_4f8c\n1d2e9a7b")).toMatch(/line breaks/);
    expect(keyProblem("ts_live 4f8c1d2e9a7b")).toMatch(/spaces/);
  });
});
