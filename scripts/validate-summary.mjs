// Rebuilds summary.md from the per-conversion report JSONs on disk (the
// source of truth after reruns replaced individual runs).
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const outDir = path.resolve("artifacts/validation-keep-together");

const TYPES = {
  "wiki-en": "encyclopedia (tables + infobox + images)",
  "wiki-cjk": "CJK encyclopedia (70 pages, render-heavy)",
  "docs-mdn": "developer docs (code blocks + compat tables)",
  "spa-react": "client-rendered SPA docs",
  "news-agg": "news aggregator (dense links)",
  "news-media": "heavy news front page (photo-heavy)",
  ecommerce: "e-commerce catalog grid",
  academic: "academic preprint page",
  "gov-uk": "government page (strict style-src CSP)",
  "repo-readme": "code repo README (known trailing-page quirk)",
};

const files = (await readdir(outDir)).filter((name) => name.endsWith(".report.json"));
const runs = [];
for (const file of files) {
  const report = JSON.parse(await readFile(path.join(outDir, file), "utf8"));
  const match = file.match(/^(.+)-(baseline|keep)\.report\.json$/);
  if (!match) continue;
  const pagination = (report.checks ?? []).find((check) => check.id === "render.pagination");
  runs.push({
    slug: match[1],
    variant: match[2],
    pages: report.pdf?.pageCount,
    durationMs: report.durationMs,
    readyMs: report.timings?.readinessMs,
    renderMs: report.timings?.renderMs,
    warnings: (report.warnings ?? []).map((warning) => warning.code),
    fidelity: report.fidelity?.score ?? null,
    fidelityStatus: report.fidelity?.status ?? "n/a",
    pagination: pagination ? `${pagination.status}: ${pagination.detail}` : "— (option off)",
  });
}
runs.sort((a, b) => a.slug.localeCompare(b.slug) || a.variant.localeCompare(b.variant));

const s = (ms) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)}s` : "—");
const lines = [];
lines.push("# keep-together real-world validation — 10 site types × (baseline | keepTogether)\n");
lines.push(
  "Every site converted twice with the pinned Chromium build; PDFs, per-conversion report JSON, and per-page extracted text sit next to this file (`<slug>-<variant>.pdf`). Fidelity is the report's own screen-vs-PDF SSIM sample (`fidelity.score`, 3 sampled pages, threshold 0.80).\n",
);
lines.push("| type | site | variant | pages | duration | ready | render | warnings | fidelity | pagination check |");
lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const run of runs) {
  const warnings = run.warnings.join(", ") || "—";
  const fid = run.fidelity === null ? run.fidelityStatus : `${run.fidelity} (${run.fidelityStatus})`;
  lines.push(
    `| ${TYPES[run.slug] ?? run.slug} | ${run.slug} | ${run.variant} | ${run.pages} | ${s(run.durationMs)} | ${s(run.readyMs)} | ${s(run.renderMs)} | ${warnings} | ${fid} | ${run.pagination.replaceAll("|", "\\|")} |`,
  );
}

// ---- overhead + deltas ------------------------------------------------------
const slugs = [...new Set(runs.map((run) => run.slug))].sort();
const pairs = slugs
  .map((slug) => ({
    slug,
    base: runs.find((run) => run.slug === slug && run.variant === "baseline"),
    keep: runs.find((run) => run.slug === slug && run.variant === "keep"),
  }))
  .filter((pair) => pair.base && pair.keep);

lines.push("\n## keepTogether deltas (keep − baseline)\n");
lines.push("| site | render base → keep | Δrender | pages | fidelity |");
lines.push("| --- | --- | --- | --- | --- |");
const overheads = [];
for (const pair of pairs) {
  const delta = pair.keep.renderMs - pair.base.renderMs;
  overheads.push(delta);
  const fid = (value) => (value === null ? "n/a" : value.toFixed(4));
  lines.push(
    `| ${pair.slug} | ${s(pair.base.renderMs)} → ${s(pair.keep.renderMs)} | ${(delta >= 0 ? "+" : "")}${(delta / 1000).toFixed(2)}s | ${pair.base.pages} → ${pair.keep.pages} | ${fid(pair.base.fidelity)} → ${fid(pair.keep.fidelity)} |`,
  );
}
const sorted = [...overheads].sort((a, b) => a - b);
const median = sorted[Math.floor(sorted.length / 2)];
lines.push(
  `\nMedian render-phase overhead: **${(median / 1000).toFixed(2)}s** (n=${overheads.length} pairs; the pre-pass measures at print geometry, which in typical screen mode is a no-resize path).`,
);

// ---- findings (hand-written, from this validation run) ----------------------
lines.push("\n## Findings\n");
lines.push(
  "- **Outcome**: all 10 site types converted in both variants — 20/20 PDFs. First pass: 17/20 (two default-deadline failures on ja.wikipedia, one BBC readiness timeout); targeted reruns completed the matrix (both explained below).",
  "- **Two real bugs found against live sites and fixed**, each locked in with a regression test:",
  "  - gov.uk's strict `style-src 'self'` CSP refused `addStyleTag`: the pass honestly reported `skipped` and the conversion was unaffected, but the feature was inert. Injection now uses a constructed stylesheet; the re-run reports `pass: 30 object(s) kept to one page`.",
  "  - MDN renders its code examples inside `<mdn-code-example>` **shadow roots** — invisible to `document.querySelectorAll` and unstylable by document-level sheets. The pass now walks open shadow roots (stylesheet adopted per root — 23 covered on MDN) and treats **iframe boxes** as candidates (Chromium honoring `break-inside: avoid` on an iframe box was probe-verified first). Live proof: baseline cuts MDN's CSS example across pages 4→5 (brace balance 4/3 then 5/6); keep holds it whole on page 5 (9/9), 7→8 pages.",
  "  - Gate after the fixes: lint 0 · typecheck 0 · unit 286 passed + 1 skipped · build 0 · e2e 120 passed + 1 skipped (new tests: strict-CSP fixture, shadow-root fixture, iframe fixture).",
  "- **Performance**: the keep pre-pass costs a median **+0.07s** of render time (worst +0.15s); readiness is untouched — both variants share that code path. Durations are dominated by each site's network/readiness phase (0.7s–22s).",
  "- **ja.wikipedia (CJK, 70 pages)**: render takes 32.6–32.8s — over the default 30s render deadline, so both default-mode runs failed with `RENDER_TIMEOUT`; both complete with `render.timeoutMs: 120000`. Guidance: raise the render deadline for very long CJK-heavy documents.",
  "- **BBC news front**: readiness's network stage timed out on 2 of 3 baseline attempts (time-varying page weight — the busy-page degrade only proceeds while pending traffic is a small share; genuinely slow transfers wait until the deadline). The third attempt settled (10.5s ready). Readiness code is identical for both variants — site variance, not the option.",
  "- **Warnings stay honest**: pre-existing warnings (`resources.request-failed`, `fidelity.low-score` on the academic/ecommerce/repo pages) persist unchanged in both variants; keep adds `pdf.empty-pages` once (repo-readme) because whole-object moves shifted the document tail past the last boundary into a textless page 5 — a legitimate pagination outcome, warned in the report.",
  "- **Fidelity deltas** ≤ 0.016 on 8/10 sites. Expected outliers: docs-mdn 0.8966 → 0.7757 (the pushed example changes page composition vs the screen capture → `fidelity.low-score` on keep, documented) and repo-readme 0.6404 → 0.6672 (**improved** — commit rows kept whole). news-media ≈ 0.36 with and without the option (photo-heavy front page).",
  "- **Too-tall guard fired on real content**: news-agg 2 objects, wiki-cjk 1 — those fragment normally instead of overflowing invisibly past a page edge.",
  "- The option defaults to off: baseline rows are untouched behavior.",
  "",
  "_Regenerate with `node scripts/validate-summary.mjs` (reads the report JSONs in this folder)._",
);

await writeFile(path.join(outDir, "summary.md"), lines.join("\n"));
console.log(`summary.md rebuilt from ${runs.length} reports`);
