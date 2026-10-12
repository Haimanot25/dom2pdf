import { describe, expect, it } from "vitest";
import { ENGINE_NAMES, SCENARIO_NAMES } from "pageforge-benchmark";
import { parseNameList } from "../src/benchmark.js";
import { UsageError } from "../src/shared.js";

describe("benchmark flag parsing", () => {
  it("passes an omitted list through as undefined (harness defaults apply)", () => {
    expect(parseNameList("scenarios", undefined, SCENARIO_NAMES)).toBeUndefined();
  });

  it("splits, trims, and drops empty segments", () => {
    expect(parseNameList("scenarios", "simple, print-css ,", SCENARIO_NAMES)).toEqual([
      "simple",
      "print-css",
    ]);
  });

  it("rejects unknown names with a usage error listing the valid ones", () => {
    let caught: unknown;
    try {
      parseNameList("engines", "pageforge,typo-engine", ENGINE_NAMES);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(UsageError);
    expect((caught as Error).message).toContain("typo-engine");
    expect((caught as Error).message).toContain("weasyprint");
  });

  it("rejects a flag with no names at all", () => {
    expect(() => parseNameList("engines", " , ", ENGINE_NAMES)).toThrow(UsageError);
  });
});
