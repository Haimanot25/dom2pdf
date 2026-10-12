import { describe, expect, it } from "vitest";
import { SCENARIOS, SCENARIO_NAMES } from "../src/scenarios.js";

describe("benchmark scenarios", () => {
  it("exposes stable, unique names in registry order", () => {
    expect(SCENARIO_NAMES).toEqual(["simple", "long-document", "print-css", "screen-dashboard"]);
    expect(new Set(SCENARIO_NAMES).size).toBe(SCENARIOS.length);
  });

  it("generates byte-identical HTML on every call (determinism)", () => {
    for (const scenario of SCENARIOS) {
      expect(scenario.html()).toBe(scenario.html());
    }
  });

  it("produces self-contained documents with no external references", () => {
    for (const scenario of SCENARIOS) {
      const html = scenario.html();
      expect(html).toMatch(/^<!doctype html>/i);
      expect(html).not.toMatch(/https?:\/\//); // no network fetches → runs offline identically
      expect(html).toContain("<title>");
    }
  });

  it("gives the screen scenario its screen-mode pipeline", () => {
    const dashboard = SCENARIOS.find((scenario) => scenario.name === "screen-dashboard");
    expect(dashboard?.pageforgeOptions?.mode).toBe("screen");
    const simple = SCENARIOS.find((scenario) => scenario.name === "simple");
    expect(simple?.pageforgeOptions).toBeUndefined();
  });

  it("scales the long document to many paragraphs", () => {
    const html = SCENARIOS.find((scenario) => scenario.name === "long-document")?.html() ?? "";
    expect(html.match(/<h2>Section /g)?.length).toBe(120);
  });
});
