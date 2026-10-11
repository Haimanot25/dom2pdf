import { describe, expect, it } from "vitest";
import type { NormalizedQualityOptions } from "../src/config/normalize.js";
import { PageForgeError } from "../src/errors/index.js";
import { assertQualityPolicy, qualityViolations, type QualityMetrics } from "../src/quality/policy.js";
import { buildQualityReport } from "../src/quality/report.js";

function policy(overrides: Partial<NormalizedQualityOptions> = {}): NormalizedQualityOptions {
  return {
    minTextChars: undefined,
    minPages: undefined,
    maxPages: undefined,
    maxBytes: undefined,
    failOnWarnings: false,
    ...overrides,
  };
}

function metrics(overrides: Partial<QualityMetrics> = {}): QualityMetrics {
  return { pageCount: 3, byteLength: 50_000, textChars: 2_000, warningCodes: [], ...overrides };
}

function report() {
  return buildQualityReport({
    durationMs: 123,
    mode: "document",
    browserVersion: "156.0.0.0",
    inspection: { byteLength: 50_000, pageCount: 3, headerVersion: "1.7", text: null },
    timings: { readinessMs: 10, renderMs: 50 },
  });
}

describe("qualityViolations", () => {
  it("reports no violations when no rules are configured", () => {
    expect(qualityViolations(policy(), metrics({ pageCount: 1, textChars: 0, warningCodes: ["x"] }))).toEqual(
      [],
    );
  });

  it("reports no violations when every rule passes", () => {
    expect(
      qualityViolations(policy({ minTextChars: 100, minPages: 1, maxPages: 10, maxBytes: 1_000_000 }), metrics()),
    ).toEqual([]);
  });

  it("flags text below the minimum", () => {
    const violations = qualityViolations(policy({ minTextChars: 10_000 }), metrics({ textChars: 42 }));
    expect(violations).toEqual([
      { rule: "minTextChars", message: "expected at least 10000 extractable characters, measured 42" },
    ]);
  });

  it("flags page counts outside the allowed range", () => {
    expect(qualityViolations(policy({ minPages: 5 }), metrics({ pageCount: 2 }))).toEqual([
      { rule: "minPages", message: "expected at least 5 page(s), measured 2" },
    ]);
    expect(qualityViolations(policy({ maxPages: 2 }), metrics({ pageCount: 7 }))).toEqual([
      { rule: "maxPages", message: "expected at most 2 page(s), measured 7" },
    ]);
  });

  it("flags oversized output", () => {
    expect(qualityViolations(policy({ maxBytes: 1_000 }), metrics({ byteLength: 2_000 }))).toEqual([
      { rule: "maxBytes", message: "expected at most 1000 bytes, measured 2000" },
    ]);
  });

  it("flags warnings when failOnWarnings is set, listing their codes", () => {
    const violations = qualityViolations(
      policy({ failOnWarnings: true }),
      metrics({ warningCodes: ["layout.horizontal-overflow", "resources.http-error"] }),
    );
    expect(violations).toHaveLength(1);
    expect(violations[0]?.rule).toBe("failOnWarnings");
    expect(violations[0]?.message).toContain("layout.horizontal-overflow");
    expect(violations[0]?.message).toContain("resources.http-error");
  });

  it("collects every violated rule at once", () => {
    const violations = qualityViolations(
      policy({ minTextChars: 1_000_000, maxPages: 1, failOnWarnings: true }),
      metrics({ textChars: 5, pageCount: 4, warningCodes: ["pdf.empty-pages"] }),
    );
    expect(violations.map((violation) => violation.rule)).toEqual(["minTextChars", "maxPages", "failOnWarnings"]);
  });
});

describe("assertQualityPolicy", () => {
  it("returns normally when the policy passes", () => {
    expect(() => assertQualityPolicy(policy({ minPages: 1, maxPages: 5 }), metrics(), report())).not.toThrow();
  });

  it("throws QUALITY_POLICY_FAILED carrying violations and the report", () => {
    try {
      assertQualityPolicy(policy({ minPages: 10 }), metrics(), report());
      throw new Error("expected assertQualityPolicy to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(PageForgeError);
      const pageForgeError = error as PageForgeError;
      expect(pageForgeError.code).toBe("QUALITY_POLICY_FAILED");
      expect(pageForgeError.message).toContain("expected at least 10 page(s), measured 3");
      const violations = pageForgeError.details?.["violations"] as Array<{ rule: string }>;
      expect(violations.map((violation) => violation.rule)).toEqual(["minPages"]);
      const attached = pageForgeError.details?.["report"] as { pdf: { pageCount: number } };
      expect(attached.pdf.pageCount).toBe(3);
    }
  });
});
