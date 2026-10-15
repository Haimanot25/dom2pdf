import { expect, test } from "@playwright/test";
import { createConverter, inspectPdf, type Converter } from "../packages/core/dist/index.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * Scroll-driven content: pages that keep content back until the reader
 * scrolls — reveal-on-scroll animations (sections at opacity 0 until an
 * IntersectionObserver fires) and fetch-on-scroll feeds (infinite scroll).
 * The lazy sweep walks every scrollable document so both patterns are
 * present in the capture; these tests prove it on real fixtures, with a
 * no-sweep control to show what the sweep is responsible for.
 */

let server: FixtureServer;
let converter: Converter;

test.beforeAll(async () => {
  server = await startFixtureServer();
  converter = await createConverter();
});

test.afterAll(async () => {
  await converter?.close();
  await server?.close();
});

async function extractedText(bytes: Uint8Array): Promise<string> {
  const inspection = await inspectPdf(bytes, { extractText: true });
  return inspection.text?.pages.join("\n") ?? "";
}

test.describe("scroll-driven content", () => {
  test("reveal-on-scroll sections are painted, and absent without the sweep", async () => {
    const url = `${server.origin}/reveal-on-scroll.html`;

    const swept = await converter.convert({
      input: { type: "url", url },
      security: { allowLoopback: true },
    });
    const sweptText = await extractedText(swept.bytes);
    for (let section = 0; section <= 5; section += 1) {
      expect(sweptText, `REVEAL-SECTION-${section} should be painted in the PDF`).toContain(
        `REVEAL-SECTION-${section}`,
      );
    }
    expect(swept.report.checks.find((check) => check.id === "readiness")?.detail).toContain(
      "lazy sweep",
    );

    // Control: with the sweep disabled the same page prints blank sections.
    // Invisible (opacity 0) text is never painted, so it cannot appear in
    // the extracted text — this pins the improvement on the sweep itself.
    const bare = await converter.convert({
      input: { type: "url", url },
      readiness: { lazyLoad: false },
      security: { allowLoopback: true },
    });
    const bareText = await extractedText(bare.bytes);
    expect(bareText).toContain("REVEAL-SECTION-0");
    expect(bareText).not.toContain("REVEAL-SECTION-3");
    expect(bareText).not.toContain("REVEAL-SECTION-5");
  });

  test("fetch-on-scroll appends are drained into the PDF", async () => {
    const url = `${server.origin}/infinite-scroll.html`;
    const result = await converter.convert({
      input: { type: "url", url },
      security: { allowLoopback: true },
    });
    const text = await extractedText(result.bytes);

    expect(text).toContain("SCROLL-BASE-0");
    for (let chunk = 1; chunk <= 4; chunk += 1) {
      expect(text, `SCROLL-APPEND-${chunk} should be in the PDF`).toContain(`SCROLL-APPEND-${chunk}`);
    }
    const readiness = result.report.checks.find((check) => check.id === "readiness");
    expect(readiness?.detail).toContain("lazy sweep");
    expect(readiness?.detail).not.toContain("(truncated)");
    expect(
      result.report.warnings.some((warning) => warning.code === "resources.lazy-load-truncated"),
    ).toBe(false);
  });

  test("short static pages pay no sweep", async () => {
    const url = `${server.origin}/basic-text.html`;
    const result = await converter.convert({
      input: { type: "url", url },
      security: { allowLoopback: true },
    });
    expect(result.report.checks.find((check) => check.id === "readiness")?.detail).not.toContain(
      "lazy sweep",
    );
  });

  test("slide-in reveals are captured settled, never mid-animation", async () => {
    // The fixture's sections slide in from off-page over 8s (ease-out), so a
    // capture taken while the transition runs clips the left part of each
    // line at the page edge — the full marker string can only be extracted
    // from a capture taken at the settled end state.
    const url = `${server.origin}/reveal-slide.html`;
    const result = await converter.convert({
      input: { type: "url", url },
      security: { allowLoopback: true },
    });
    const text = await extractedText(result.bytes);
    for (const marker of ["ALPHA", "BRAVO", "CHARLIE"]) {
      expect(text, `SLIDE-MARKER-${marker} should be fully painted`).toContain(
        `SLIDE-MARKER-${marker}-KEEPSAKE-FULLY-VISIBLE`,
      );
    }
  });
});
