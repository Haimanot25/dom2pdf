import { describe, expect, it } from "vitest";
import { layoutWarnings, type LayoutFindings } from "../src/layout-analysis/analyze.js";

function findings(overrides: Partial<LayoutFindings> = {}): LayoutFindings {
  return {
    viewportWidth: 1280,
    contentWidth: 1280,
    horizontalOverflowPx: 0,
    fixedOrStickyElements: 0,
    scrollableContainers: 0,
    ...overrides,
  };
}

describe("layoutWarnings", () => {
  it("returns no warnings for a clean layout", () => {
    expect(layoutWarnings(findings())).toEqual([]);
  });

  it("warns about horizontal overflow with measured pixel counts", () => {
    const warnings = layoutWarnings(findings({ contentWidth: 3000, horizontalOverflowPx: 1720 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({
      code: "layout.horizontal-overflow",
      source: "heuristic",
    });
    expect(warnings[0]?.message).toContain("1720px");
    expect(warnings[0]?.message).toContain("1280px");
  });

  it("warns about fixed/sticky elements with a count", () => {
    const warnings = layoutWarnings(findings({ fixedOrStickyElements: 2 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "screen.fixed-elements", source: "heuristic" });
    expect(warnings[0]?.message).toContain("2 fixed/sticky");
  });

  it("warns about scroll containers with hidden overflow", () => {
    const warnings = layoutWarnings(findings({ scrollableContainers: 1 }));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatchObject({ code: "screen.scrollable-containers", source: "heuristic" });
  });

  it("combines every finding and always labels them heuristic", () => {
    const warnings = layoutWarnings(
      findings({ horizontalOverflowPx: 40, fixedOrStickyElements: 1, scrollableContainers: 3 }),
    );
    expect(warnings.map((warning) => warning.code)).toEqual([
      "layout.horizontal-overflow",
      "screen.fixed-elements",
      "screen.scrollable-containers",
    ]);
    for (const warning of warnings) expect(warning.source).toBe("heuristic");
  });

  it("treats zero/negative overflow as clean", () => {
    expect(layoutWarnings(findings({ contentWidth: 900, horizontalOverflowPx: 0 }))).toEqual([]);
  });
});
