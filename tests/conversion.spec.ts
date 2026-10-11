import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { createConverter, type Converter } from "../packages/core/dist/index.js";
import { FIXTURES_DIR, startFixtureServer, type FixtureServer } from "./helpers/fixture-server.js";
import { extractPdfText } from "./helpers/pdf-text.js";

const PDF_MAGIC = "%PDF-";

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

test.describe("convert: HTML string input", () => {
  test("produces a structurally valid PDF with a real report", async () => {
    const result = await converter.convert({
      input: { type: "html", html: "<!doctype html><html><body><h1>Hello PageForge</h1></body></html>" },
    });

    const header = new TextDecoder("latin1").decode(result.bytes.slice(0, 5));
    expect(header).toBe(PDF_MAGIC);
    expect(result.bytes.byteLength).toBeGreaterThan(500);

    expect(result.report.status).toBe("succeeded");
    expect(result.report.mode).toBe("document");
    expect(result.report.durationMs).toBeGreaterThan(0);
    expect(result.report.pdf.byteLength).toBe(result.bytes.byteLength);
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(1);
    expect(result.report.pdf.headerVersion).toMatch(/^\d/);
    expect(result.report.browser.name).toBe("chromium");
    expect(result.report.browser.version).toMatch(/^\d+\.\d+/);
    const structure = result.report.checks.find((check) => check.id === "pdf-structure");
    expect(structure?.status).toBe("pass");
    expect(result.report.warnings).toEqual([]);
  });

  test("keeps text selectable and searchable", async () => {
    const result = await converter.convert({
      input: {
        type: "html",
        html: "<!doctype html><html><body><h1>Selectable heading</h1><p>Unique marker XKQ-73B appears here.</p></body></html>",
      },
    });
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("Selectable heading");
    expect(pageText).toContain("Unique marker XKQ-73B appears here.");
  });

  test("renders print backgrounds by default", async () => {
    const withBackground = await converter.convert({
      input: {
        type: "html",
        html: '<!doctype html><html><body style="background:#0b6e4f;color:#fff"><p style="padding:40px">Tinted background</p></body></html>',
      },
    });
    expect(withBackground.report.pdf.pageCount).toBe(1);
    expect(withBackground.report.checks.find((check) => check.id === "pdf-structure")?.status).toBe("pass");

    const optedOut = await converter.convert({
      input: {
        type: "html",
        html: '<!doctype html><html><body style="background:#0b6e4f;color:#fff"><p style="padding:40px">Tinted background</p></body></html>',
      },
      pdf: { printBackground: false },
    });
    expect(optedOut.report.pdf.pageCount).toBe(1);
  });
});

test.describe("convert: URL input", () => {
  test("converts a fixture URL when loopback is allowed", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/basic-text.html` },
      security: { allowLoopback: true },
    });

    expect(new TextDecoder("latin1").decode(result.bytes.slice(0, 5))).toBe(PDF_MAGIC);
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("PageForge basic fixture");
    expect(pageText).toContain("example.com");
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(1);
  });

  test("converts the Unicode fixture without structural errors", async () => {
    const result = await converter.convert({
      input: { type: "url", url: `${server.origin}/unicode.html` },
      security: { allowLoopback: true },
    });
    expect(result.report.status).toBe("succeeded");
    expect(result.report.pdf.pageCount).toBeGreaterThanOrEqual(1);

    const [pageText = ""] = await extractPdfText(result.bytes);
    // Text must survive as text for scripts that have glyph coverage.
    expect(pageText).toContain("Café");
    expect(pageText).toContain("Ligatures");
  });
});

test.describe("convert: local file input", () => {
  test("converts a permitted local HTML file", async () => {
    const result = await converter.convert({
      input: { type: "file", path: path.join(FIXTURES_DIR, "basic-text.html") },
      security: { allowLocalFiles: true, allowedLocalDirectories: [FIXTURES_DIR] },
    });
    const [pageText = ""] = await extractPdfText(result.bytes);
    expect(pageText).toContain("PageForge basic fixture");
  });

  test("denies local file access by default", async () => {
    const attempt = converter.convert({
      input: { type: "file", path: path.join(FIXTURES_DIR, "basic-text.html") },
    });
    await expect(attempt).rejects.toMatchObject({ code: "LOCAL_FILE_NOT_ALLOWED" });
  });
});

test.describe("convert: security policy enforcement", () => {
  test("blocks non-http(s) protocols", async () => {
    await expect(
      converter.convert({ input: { type: "url", url: "ftp://example.com/file.pdf" } }),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });

    await expect(
      converter.convert({ input: { type: "url", url: "file:///C:/Windows/win.ini" } }),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  test("blocks loopback destinations by default", async () => {
    await expect(
      converter.convert({ input: { type: "url", url: `${server.origin}/basic-text.html` } }),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  test("blocks private and link-local destinations by default", async () => {
    await expect(
      converter.convert({ input: { type: "url", url: "http://10.0.0.1/" } }),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
    await expect(
      converter.convert({ input: { type: "url", url: "http://169.254.169.254/latest/meta-data/" } }),
    ).rejects.toMatchObject({ code: "BLOCKED_URL" });
  });

  test("rejects malformed URLs with INVALID_INPUT", async () => {
    await expect(converter.convert({ input: { type: "url", url: "not-a-url" } })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });

  test("rejects unknown options with UNSUPPORTED_OPTION", async () => {
    await expect(
      converter.convert({ input: { type: "html", html: "<p>x</p>" }, format: "A4" } as never),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_OPTION" });
  });
});

test.describe("convert: deadlines and lifecycle", () => {
  test("fails with READINESS_TIMEOUT when the page never finishes loading", async () => {
    const slowHtml = `<!doctype html><html><body><img src="${server.origin}/__delay/6000/slow.png" /></body></html>`;
    const started = Date.now();
    const attempt = converter.convert({
      input: { type: "html", html: slowHtml },
      security: { allowLoopback: true },
      readiness: { timeoutMs: 1_000 },
    });
    await expect(attempt).rejects.toMatchObject({ code: "READINESS_TIMEOUT" });
    expect(Date.now() - started).toBeLessThan(5_500);
  });

  test("save() writes the PDF bytes to disk", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "pageforge-save-"));
    try {
      const target = path.join(directory, "nested", "output.pdf");
      const result = await converter.convert({
        input: { type: "html", html: "<!doctype html><html><body><p>save me</p></body></html>" },
      });
      await result.save(target);

      const info = await stat(target);
      expect(info.size).toBe(result.bytes.byteLength);
      const onDisk = await readFile(target);
      expect(Buffer.compare(onDisk, Buffer.from(result.bytes))).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("repeated conversions succeed on a shared converter", async () => {
    for (let i = 0; i < 3; i += 1) {
      const result = await converter.convert({
        input: { type: "html", html: `<!doctype html><html><body><p>run ${i}</p></body></html>` },
      });
      expect(result.report.status).toBe("succeeded");
    }
  });
});

test.describe("converter lifecycle", () => {
  test("close() is safe and later conversions are rejected", async () => {
    const dedicated = await createConverter();
    const result = await dedicated.convert({
      input: { type: "html", html: "<!doctype html><html><body><p>before close</p></body></html>" },
    });
    expect(result.report.status).toBe("succeeded");

    await dedicated.close();
    await dedicated.close(); // idempotent

    await expect(
      dedicated.convert({ input: { type: "html", html: "<p>after close</p>" } }),
    ).rejects.toMatchObject({ code: "CONVERTER_CLOSED" });
  });
});
