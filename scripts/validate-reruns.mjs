// Reruns gov.uk keep, both ja.wikipedia variants (default 30s render deadline
// timed out), and BBC baseline (READINESS_TIMEOUT variance). Live internet, not in CI.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createConverter } from "../packages/core/dist/index.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const outDir = path.resolve("artifacts/validation-keep-together");
await mkdir(outDir, { recursive: true });

async function extractPages(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(content.items.map((item) => ("str" in item ? item.str : "")).join(""));
    }
    return pages;
  } finally {
    await task.destroy?.().catch(() => undefined);
  }
}

const RUNS = [
  {
    slug: "gov-uk",
    variant: "keep",
    url: "https://www.gov.uk/government/organisations/home-office",
    options: { pagination: { keepTogether: true } },
  },
  {
    slug: "wiki-cjk",
    variant: "baseline",
    url: "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E",
    options: {},
    note: "render deadline raised to 120s (default 30s timed out)",
  },
  {
    slug: "wiki-cjk",
    variant: "keep",
    url: "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E",
    options: { pagination: { keepTogether: true } },
    note: "render deadline raised to 120s (default 30s timed out)",
  },
  {
    slug: "news-media",
    variant: "baseline",
    url: "https://www.bbc.com/news",
    options: {},
    note: "variance retry after first run hit READINESS_TIMEOUT",
  },
];

const converter = await createConverter();
const rows = [];

for (const run of RUNS) {
  const started = performance.now();
  try {
    const result = await converter.convert({
      input: { type: "url", url: run.url },
      render: { timeoutMs: 120_000 },
      ...run.options,
    });
    const wallMs = performance.now() - started;
    const pdfPath = path.join(outDir, `${run.slug}-${run.variant}.pdf`);
    await result.save(pdfPath);
    await writeFile(path.join(outDir, `${run.slug}-${run.variant}.report.json`), JSON.stringify(result.report, null, 2));
    const pages = await extractPages(result.bytes);
    await writeFile(
      path.join(outDir, `${run.slug}-${run.variant}.pages.txt`),
      pages.map((text, index) => `===== PAGE ${index + 1} (${text.length} chars) =====\n${text}`).join("\n\n"),
    );
    const paginationCheck = result.report.checks.find((check) => check.id === "render.pagination");
    rows.push({
      slug: run.slug,
      variant: run.variant,
      note: run.note ?? "",
      ok: true,
      wallMs,
      readinessMs: result.report.timings?.readinessMs,
      renderMs: result.report.timings?.renderMs,
      pageCount: result.report.pdf?.pageCount,
      warnings: (result.report.warnings ?? []).map((warning) => warning.code),
      fidelity: result.report.fidelity?.score,
      pagination: paginationCheck ? `${paginationCheck.status}: ${paginationCheck.detail}` : "—",
    });
    console.log(
      `ok   ${run.slug} [${run.variant}] pages=${rows.at(-1).pageCount} wall=${(wallMs / 1000).toFixed(1)}s ` +
        `render=${((rows.at(-1).renderMs ?? 0) / 1000).toFixed(1)}s warn=[${rows.at(-1).warnings.join(",")}] ` +
        `fidelity=${rows.at(-1).fidelity ?? "n/a"} | ${rows.at(-1).pagination.slice(0, 110)}`,
    );
  } catch (error) {
    rows.push({ slug: run.slug, variant: run.variant, note: run.note ?? "", ok: false, code: error?.code ?? "UNKNOWN", message: String(error?.message ?? error).slice(0, 200) });
    console.log(`FAIL ${run.slug} [${run.variant}] ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 140)}`);
  }
}

await converter.close();
await writeFile(path.join(outDir, "reruns.json"), JSON.stringify(rows, null, 2));
console.log("\nReruns done:", rows.filter((row) => row.ok).length, "/", rows.length, "succeeded");
