// BBC baseline retry: defaults first, then readiness.timeoutMs=60000 if that
// fails, to obtain the side-by-side baseline PDF. Live internet, not in CI.
import path from "node:path";
import { performance } from "node:perf_hooks";
import { writeFile } from "node:fs/promises";
import { createConverter } from "../packages/core/dist/index.js";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

const outDir = path.resolve("artifacts/validation-keep-together");
const URL_ = "https://www.bbc.com/news";

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

async function attempt(label, readiness) {
  const converter = await createConverter();
  const started = performance.now();
  try {
    const result = await converter.convert({
      input: { type: "url", url: URL_ },
      readiness,
    });
    const wallMs = performance.now() - started;
    const pages = await extractPages(result.bytes);
    await result.save(path.join(outDir, "news-media-baseline.pdf"));
    await writeFile(
      path.join(outDir, "news-media-baseline.report.json"),
      JSON.stringify(result.report, null, 2),
    );
    await writeFile(
      path.join(outDir, "news-media-baseline.pages.txt"),
      pages.map((text, index) => `===== PAGE ${index + 1} (${text.length} chars) =====\n${text}`).join("\n\n"),
    );
    console.log(
      `ok   ${label}: pages=${pages.length} wall=${(wallMs / 1000).toFixed(1)}s ` +
        `warn=[${(result.report.warnings ?? []).map((w) => w.code).join(",")}] ` +
        `fidelity=${result.report.fidelity?.score ?? "n/a"}`,
    );
    return { ok: true, label, pages: pages.length, wallMs };
  } catch (error) {
    console.log(`FAIL ${label}: ${error?.code ?? ""} ${String(error?.message ?? error).slice(0, 120)}`);
    return { ok: false, label, code: error?.code ?? "UNKNOWN" };
  } finally {
    await converter.close();
  }
}

const attempts = [];
attempts.push(await attempt("defaults (attempt 3)", undefined));
if (!attempts.at(-1).ok) {
  attempts.push(await attempt("readiness.timeoutMs=60000", { timeoutMs: 60_000 }));
}
await writeFile(path.join(outDir, "bbc-retry.json"), JSON.stringify(attempts, null, 2));
console.log("BBC attempts:", JSON.stringify(attempts));
