// Converts 10 site types twice each (baseline vs keepTogether); writes PDFs,
// per-page text, and a markdown summary. Manual harness; live internet, not in CI.
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { createConverter } from "../packages/core/dist/index.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const SITES = [
  {
    slug: "wiki-en",
    type: "encyclopedia (tables + infobox + images)",
    url: "https://en.wikipedia.org/wiki/Web_browser",
  },
  { slug: "wiki-cjk", type: "CJK encyclopedia", url: "https://ja.wikipedia.org/wiki/%E6%97%A5%E6%9C%AC%E8%AA%9E" },
  {
    slug: "docs-mdn",
    type: "developer docs (code blocks + compat tables)",
    url: "https://developer.mozilla.org/en-US/docs/Web/CSS/break-inside",
  },
  { slug: "spa-react", type: "client-rendered SPA docs", url: "https://react.dev/learn" },
  { slug: "news-agg", type: "news aggregator (dense links)", url: "https://news.ycombinator.com/" },
  { slug: "news-media", type: "heavy news front page", url: "https://www.bbc.com/news" },
  { slug: "ecommerce", type: "e-commerce catalog grid", url: "https://books.toscrape.com/" },
  { slug: "academic", type: "academic preprint page", url: "https://arxiv.org/abs/1706.03762" },
  {
    slug: "gov-uk",
    type: "government service page",
    url: "https://www.gov.uk/government/organisations/home-office",
  },
  { slug: "repo-readme", type: "code repo README (known trailing-page quirk)", url: "https://github.com/microsoft/TypeScript" },
];

async function extractPages(bytes) {
  const task = getDocument({ data: new Uint8Array(bytes), verbosity: 0 });
  try {
    const doc = await task.promise;
    const pages = [];
    for (let i = 1; i <= doc.numPages; i += 1) {
      const page = await doc.getPage(i);
      const content = await page.getTextContent();
      pages.push(
        content.items
          .map((item) => ("str" in item ? item.str : ""))
          .join(""),
      );
    }
    return pages;
  } finally {
    await task.destroy().catch(() => undefined);
  }
}

const outDir = path.resolve("artifacts/validation-keep-together");
await mkdir(outDir, { recursive: true });

const converter = await createConverter();
const rows = [];

for (const site of SITES) {
  for (const variant of ["baseline", "keep"]) {
    const started = performance.now();
    const label = `${site.slug} [${variant}]`;
    try {
      const result = await converter.convert({
        input: { type: "url", url: site.url },
        ...(variant === "keep" ? { pagination: { keepTogether: true } } : {}),
      });
      const wallMs = performance.now() - started;
      const pdfPath = path.join(outDir, `${site.slug}-${variant}.pdf`);
      await result.save(pdfPath);
      await writeFile(
        path.join(outDir, `${site.slug}-${variant}.report.json`),
        JSON.stringify(result.report, null, 2),
      );
      const pages = await extractPages(result.bytes);
      await writeFile(
        path.join(outDir, `${site.slug}-${variant}.pages.txt`),
        pages.map((text, index) => `===== PAGE ${index + 1} (${text.length} chars) =====\n${text}`).join("\n\n"),
      );
      const paginationCheck = result.report.checks.find((check) => check.id === "render.pagination");
      rows.push({
        ...site,
        variant,
        ok: true,
        wallMs,
        durationMs: result.report.durationMs,
        readinessMs: result.report.timings?.readinessMs,
        renderMs: result.report.timings?.renderMs,
        pageCount: result.report.pdf?.pageCount,
        warnings: (result.report.warnings ?? []).map((warning) => warning.code),
        fidelity: result.report.fidelity?.score,
        pagination: paginationCheck ? `${paginationCheck.status}: ${paginationCheck.detail}` : "—",
        pdfFile: path.basename(pdfPath),
        minPageChars: Math.min(...pages.map((text) => text.length)),
      });
      console.log(
        `ok   ${label.padEnd(22)} pages=${rows.at(-1).pageCount} wall=${(wallMs / 1000).toFixed(1)}s ` +
          `ready=${((rows.at(-1).readinessMs ?? 0) / 1000).toFixed(1)}s render=${((rows.at(-1).renderMs ?? 0) / 1000).toFixed(1)}s ` +
          `warn=[${rows.at(-1).warnings.join(",")}] fidelity=${rows.at(-1).fidelity ?? "n/a"}`,
      );
    } catch (error) {
      const wallMs = performance.now() - started;
      rows.push({
        ...site,
        variant,
        ok: false,
        wallMs,
        code: error?.code ?? "UNKNOWN",
        message: String(error?.message ?? error).slice(0, 200),
      });
      console.log(`FAIL ${label.padEnd(22)} ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 120)}`);
    }
  }
}

await converter.close();

// ---- summary ---------------------------------------------------------------
const fmt = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "—");
const lines = [];
lines.push("# keep-together real-world validation\n");
lines.push(`Chromium-converter run on ${new Date().toISOString()}; PDFs and per-page text next to this file.\n`);
lines.push("| type | site | variant | pages | wall | ready | render | warnings | fidelity | pagination check |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const row of rows) {
  if (row.ok) {
    lines.push(
      `| ${row.type} | ${row.slug} | ${row.variant} | ${row.pageCount} | ${fmt(row.wallMs)} | ${fmt(row.readinessMs)} | ${fmt(row.renderMs)} | ${row.warnings.join(", ") || "—"} | ${row.fidelity ?? "—"} | ${row.pagination.replaceAll("|", "\\|")} |`,
    );
  } else {
    lines.push(`| ${row.type} | ${row.slug} | ${row.variant} | FAILED | ${fmt(row.wallMs)} | — | — | ${row.code}: ${row.message.replaceAll("|", "\\|")} | — | — |`);
  }
}

const pairs = SITES.map((site) => ({
  site: site.slug,
  baseline: rows.find((row) => row.slug === site.slug && row.variant === "baseline"),
  keep: rows.find((row) => row.slug === site.slug && row.variant === "keep"),
})).filter((pair) => pair.baseline?.ok && pair.keep?.ok);

if (pairs.length > 0) {
  const overheads = pairs.map((pair) => pair.keep.renderMs - pair.baseline.renderMs);
  const median = [...overheads].sort((a, b) => a - b)[Math.floor(overheads.length / 2)];
  lines.push("\n## keepTogether overhead (render phase, keep − baseline)\n");
  lines.push("| site | baseline render | keep render | delta | baseline pages | keep pages |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const pair of pairs) {
    lines.push(
      `| ${pair.site} | ${fmt(pair.baseline.renderMs)} | ${fmt(pair.keep.renderMs)} | ${(pair.keep.renderMs - pair.baseline.renderMs >= 0 ? "+" : "")}${((pair.keep.renderMs - pair.baseline.renderMs) / 1000).toFixed(2)}s | ${pair.baseline.pageCount} | ${pair.keep.pageCount} |`,
    );
  }
  lines.push(`\nMedian render overhead: ${(median / 1000).toFixed(2)}s`);
}

await writeFile(path.join(outDir, "summary.md"), lines.join("\n"));
await writeFile(path.join(outDir, "results.json"), JSON.stringify(rows, null, 2));
console.log(`\nDone. ${rows.filter((row) => row.ok).length}/${rows.length} conversions succeeded.`);
console.log(`Artifacts: ${outDir}`);
