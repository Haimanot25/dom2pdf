import { expect, test } from "@playwright/test";
import { createConverter, type Converter } from "../packages/core/dist/index.js";
import { extractPdfText } from "./helpers/pdf-text.js";
import { startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";

/**
 * Object-aware pagination (`pagination.keepTogether`).
 *
 * Geometry: A4 portrait (297mm ≈ 1122.5px) with zero margins at scale 1, so
 * every fixture positions its objects against a known page boundary. The
 * expected outcomes below were verified against this Chromium build before
 * being asserted — Chromium's print engine does not split table rows on its
 * own (it clips their boxes at the page edge instead), does not honor
 * `break-after: avoid`, and pushes avoid-blocks it cannot fit past the page
 * edge; the assertions encode exactly what the feature changes.
 */

let converter: Converter;
let server: FixtureServer;

test.beforeAll(async () => {
  converter = await createConverter();
  server = await startFixtureServer();
});

test.afterAll(async () => {
  await converter?.close();
  await server?.close();
});

function rowMarkers(rowCount: number): string {
  return Array.from(
    { length: rowCount },
    (_, index) => `<tr><td>ROW${index + 1}-START cell ${index + 1} ROW${index + 1}-END</td></tr>`,
  ).join("");
}

/** Spacer + a table sized so a specific row straddles the first page boundary. */
function tableFixture(spacerPx: number, rowCount: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  table { border-collapse: collapse; width: 640px; }
  td { height: 50px; border: 1px solid #444; font: 14px monospace; }
</style></head><body>
<div style="height:${spacerPx}px">SPACER</div>
<table>${rowMarkers(rowCount)}</table>
</body></html>`;
}

/** A table whose header group was overridden the way responsive layouts do. */
function headerFixture(): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  table { border-collapse: collapse; width: 640px; }
  thead { display: table-row-group; }
  td { height: 50px; border: 1px solid #444; font: 14px monospace; }
</style></head><body>
<table>
  <thead><tr><td>HEADER-ROW</td></tr></thead>
  <tbody>${rowMarkers(24)}</tbody>
</table>
</body></html>`;
}

/**
 * Spacer + figure (300×80 image + caption). `captionRepeats` tunes the
 * caption so it either straddles the boundary (split today, kept whole with
 * the option) or exceeds a full page (never marked).
 */
function figureFixture(spacerPx: number, captionRepeats: number): string {
  const png =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  figure { margin: 0; }
  img { display: block; width: 300px; height: 80px; image-rendering: pixelated; }
  figcaption { font: 16px/1.5 sans-serif; }
</style></head><body>
<div style="height:${spacerPx}px">SPACER</div>
<figure>
  <img src="${png}" alt="keep-together probe">
  <figcaption>CAP-START figure caption body that runs long enough to cross the page boundary on its own so the
  pairing between image and caption is what the keep rule decides. ${"Caption filler text. ".repeat(captionRepeats)}
  CAP-END</figcaption>
</figure>
</body></html>`;
}

const htmlInput = (html: string) => ({ type: "html" as const, html });
const keepTogether = { keepTogether: true } as const;

test.describe("object-aware pagination (pagination.keepTogether)", () => {
  test("is off by default: no pagination check and page breaks are unchanged", async () => {
    const result = await converter.convert({ input: htmlInput(tableFixture(1050, 6)) });

    expect(result.report.checks.find((check) => check.id === "render.pagination")).toBeUndefined();

    const pages = await extractPdfText(result.bytes);
    // Today's behavior: the table is cut at the boundary — row 2's box
    // straddles it and its text lands on page 1 while rows 3+ continue on 2.
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).toContain("ROW2-END");
    expect(pages[0]).not.toContain("ROW6-END");
  });

  test("keeps a page-fitting table whole instead of splitting it at the boundary", async () => {
    const result = await converter.convert({
      input: htmlInput(tableFixture(1050, 6)),
      pagination: keepTogether,
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("keep-together: 1 object(s) kept to one page");
    expect(check?.detail).toMatch(/page budget 1\d{3}px/);

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).not.toContain("ROW1-START"); // no two-row stub left at the page bottom
    const tableStart = pages.findIndex((page) => page.includes("ROW1-START"));
    expect(tableStart).toBe(1);
    expect(pages[tableStart]).toContain("ROW6-END"); // all six rows on one page
  });

  test("pushes a straddling row whole in a table taller than one page", async () => {
    const result = await converter.convert({
      input: htmlInput(tableFixture(1050, 24)),
      pagination: keepTogether,
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    // The 1272px table cannot fit one page, so it is deliberately not marked…
    expect(check?.detail).toContain("1 object(s) too tall to keep");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("ROW1-END");
    // …but its straddling row is pushed whole instead of clipped at the edge.
    expect(pages[0]).not.toContain("ROW2-START");
    const row2Page = pages.findIndex((page) => page.includes("ROW2-START"));
    expect(row2Page).toBeGreaterThan(0);
    expect(pages[row2Page]).toContain("ROW2-END");
  });

  test("repeats overridden table headers on continuation pages", async () => {
    const baseline = await converter.convert({ input: htmlInput(headerFixture()) });
    const baselinePages = await extractPdfText(baseline.bytes);
    expect(baselinePages[0]).toContain("HEADER-ROW");
    expect(baselinePages[1]).not.toContain("HEADER-ROW"); // the `table-row-group` override suppresses repeats

    const result = await converter.convert({
      input: htmlInput(headerFixture()),
      pagination: keepTogether,
    });
    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 table header(s) set to repeat");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("HEADER-ROW");
    const continuationPage = pages.findIndex((page, index) => index > 0 && page.includes("HEADER-ROW"));
    expect(continuationPage).toBeGreaterThan(0);
  });

  test("keeps an image with its caption together across the break", async () => {
    const baseline = await converter.convert({ input: htmlInput(figureFixture(920, 40)) });
    const baselinePages = await extractPdfText(baseline.bytes);
    expect(baselinePages[0]).toContain("CAP-START"); // today the caption splits

    const result = await converter.convert({
      input: htmlInput(figureFixture(920, 40)),
      pagination: keepTogether,
    });
    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 object(s) kept to one page");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).not.toContain("CAP-START"); // figure moved as a unit
    const captionPage = pages.findIndex((page) => page.includes("CAP-START"));
    expect(captionPage).toBeGreaterThan(0);
    expect(pages[captionPage]).toContain("CAP-END");
  });

  test("never marks objects taller than a page — no content is pushed past the page edge", async () => {
    const result = await converter.convert({
      // Spacer chosen so ~18 caption lines land before the boundary (well past
      // the orphan minimum) while the ~1530px figure exceeds the keep budget.
      input: htmlInput(figureFixture(600, 300)),
      pagination: keepTogether,
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 object(s) too tall to keep");

    const pages = await extractPdfText(result.bytes);
    // Unmarked, the figure fragments normally: its caption still starts on
    // page 1 (an avoid block this tall would overflow invisibly instead).
    expect(pages[0]).toContain("CAP-START");
  });

  test("works in screen mode with the scale-aware page budget", async () => {
    const result = await converter.convert({
      input: htmlInput(tableFixture(1750, 6)),
      mode: "screen",
      pagination: keepTogether,
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    // Screen mode paginates at the paper-fit scale: 1122.5px / 0.62 ≈ 1810px.
    expect(check?.detail).toMatch(/page budget 18\d{2}px/);

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).not.toContain("ROW1-START");
    const tableStart = pages.findIndex((page) => page.includes("ROW1-START"));
    expect(tableStart).toBeGreaterThan(0);
    expect(pages[tableStart]).toContain("ROW6-END");
  });

  test("works on pages with a strict style-src CSP (constructed stylesheets, not addStyleTag)", async () => {
    // gov.uk ships `style-src 'self' …`: inline <style>, style attributes,
    // and addStyleTag are all refused; only same-origin external CSS loads.
    // The fixture keeps all its styling in an external stylesheet.
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/keep-csp.html` },
      security: { allowLoopback: true },
      pagination: keepTogether,
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 object(s) kept to one page");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).not.toContain("ROW1-START");
    const tableStart = pages.findIndex((page) => page.includes("ROW1-START"));
    expect(tableStart).toBe(1);
    expect(pages[tableStart]).toContain("ROW6-END");
  });

  test("keeps objects inside open shadow roots (MDN-style code examples)", async () => {
    // The code example lives in <mdn-code-example>'s shadow root in the real
    // world; document.querySelectorAll never sees it, and document-level
    // sheets do not style it — the pass must walk open shadow roots and adopt
    // its constructed stylesheet per root.
    const shadowFixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
</style></head><body>
<div style="height:1050px">SPACER</div>
<div id="host"></div>
<script>
  const shadow = document.getElementById("host").attachShadow({ mode: "open" });
  shadow.innerHTML =
    "<pre id=\\"code\\" style=\\"font:14px monospace;margin:0;background:#f4f4f4;white-space:pre-wrap\\">" +
    "SHADOW-CODE-START " + "shadow code line that keeps going. ".repeat(14) + " SHADOW-CODE-END</pre>";
</script>
</body></html>`;

    const result = await converter.convert({ input: htmlInput(shadowFixture), pagination: keepTogether });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 object(s) kept to one page");
    expect(check?.detail).toContain("1 shadow root(s) covered");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).not.toContain("SHADOW-CODE-START");
    const codeStart = pages.findIndex((page) => page.includes("SHADOW-CODE-START"));
    expect(codeStart).toBe(1);
    expect(pages[codeStart]).toContain("SHADOW-CODE-END");
  });

  test("keeps a straddling iframe whole (the box is the unit of keeping)", async () => {
    // Chromium honors break-inside: avoid on the iframe box in the parent
    // document (probe-verified); inner frames are not individually scanned.
    const iframeFixture = `<!doctype html><html><head><meta charset="utf-8"><style>
  body { margin: 0; }
  iframe { border: 0; display: block; }
</style></head><body>
<div style="height:1050px">SPACER</div>
<iframe style="width:794px;height:400px" srcdoc="<!doctype html><body style='margin:0'><div style='height:300px;font:14px monospace;background:#eef'>IFRAME-BOX-TOP inner content that runs across the page boundary IFRAME-BOX-BOTTOM</div>"></iframe>
</body></html>`;

    const result = await converter.convert({ input: htmlInput(iframeFixture), pagination: keepTogether });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("pass");
    expect(check?.detail).toContain("1 object(s) kept to one page");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("SPACER");
    expect(pages[0]).not.toContain("IFRAME-BOX-TOP");
    expect(pages[1]).toContain("IFRAME-BOX-TOP");
    expect(pages[1]).toContain("IFRAME-BOX-BOTTOM");
  });

  test("reports skipped (and changes nothing) when preferCSSPageSize defers the paper to @page", async () => {
    const result = await converter.convert({
      input: htmlInput(tableFixture(1050, 6)),
      pagination: keepTogether,
      pdf: { preferCSSPageSize: true },
    });

    const check = result.report.checks.find((entry) => entry.id === "render.pagination");
    expect(check?.status).toBe("skipped");
    expect(check?.detail).toContain("@page");

    const pages = await extractPdfText(result.bytes);
    expect(pages[0]).toContain("ROW2-END"); // identical to the default split
  });
});
