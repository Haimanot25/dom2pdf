// Reruns docs-mdn (both variants) to check the code example stays whole on one
// page after the shadow-root + iframe coverage fix. Live internet, not in CI.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createConverter } from "../packages/core/dist/index.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const outDir = path.resolve("artifacts/validation-keep-together");

async function extractPages(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const p = await doc.getPage(i);
      const content = await p.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(""));
    }
    return pages;
  } finally {
    await task.destroy?.().catch(() => undefined);
  }
}

const converter = await createConverter();
const rows = [];
for (const variant of ["baseline", "keep"]) {
  const started = performance.now();
  try {
    const result = await converter.convert({
      input: { type: "url", url: "https://developer.mozilla.org/en-US/docs/Web/CSS/break-inside" },
      ...(variant === "keep" ? { pagination: { keepTogether: true } } : {}),
    });
    const wallMs = performance.now() - started;
    await result.save(path.join(outDir, `docs-mdn-${variant}.pdf`));
    await writeFile(path.join(outDir, `docs-mdn-${variant}.report.json`), JSON.stringify(result.report, null, 2));
    const pages = await extractPages(result.bytes);
    await writeFile(
      path.join(outDir, `docs-mdn-${variant}.pages.txt`),
      pages.map((text, index) => `===== PAGE ${index + 1} (${text.length} chars) =====\n${text}`).join("\n\n"),
    );
    const paginationCheck = result.report.checks.find((check) => check.id === "render.pagination");
    rows.push({
      variant,
      wallMs,
      pages: pages.length,
      warnings: (result.report.warnings ?? []).map((w) => w.code),
      fidelity: result.report.fidelity?.score,
      pagination: paginationCheck ? `${paginationCheck.status}: ${paginationCheck.detail}` : "—",
    });
    console.log(
      `ok   docs-mdn [${variant}] pages=${pages.length} wall=${(wallMs / 1000).toFixed(1)}s ` +
        `warn=[${rows.at(-1).warnings.join(",")}] fidelity=${rows.at(-1).fidelity} | ${rows.at(-1).pagination}`,
    );
  } catch (error) {
    rows.push({ variant, ok: false, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? error) });
    console.log(`FAIL docs-mdn [${variant}] ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 140)}`);
  }
}
await converter.close();
await writeFile(path.join(outDir, "mdn-rerun.json"), JSON.stringify(rows, null, 2));

// Check whether the code example still straddles pages 4-5.
const fs = await import("node:fs/promises");
for (const variant of ["baseline", "keep"]) {
  try {
    const text = await fs.readFile(path.join(outDir, `docs-mdn-${variant}.pages.txt`), "utf8");
    const marker = text.indexOf("line-height: 1.5");
    const pageOf = (pos) => text.slice(0, pos).match(/===== PAGE (\d+) /g)?.length ?? -1;
    const pageStart = text.indexOf(`===== PAGE ${pageOf(marker)} `);
    const atStart = marker - pageStart < 80;
    console.log(`css example "line-height" on page ${pageOf(marker)}; page starts there: ${atStart}`);
  } catch {
    /* pages file missing; already reported above */
  }
}
