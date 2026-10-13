# Changelog

All notable changes to PageForge are documented here. Versions follow
[semver](https://semver.org/); until `1.0.0` the API may move in minor
versions, and **error codes may be added in minor releases** (treat unknown
codes as generic failures).

## 0.1.0-alpha.0 (unreleased)

First public alpha — the six-phase foundation, in order:

### Phase 1 — Foundation
- pnpm workspace: `pageforge-pdf` (core), `pageforge-cli`, `pageforge-benchmark`.
- Strict TypeScript everywhere, ESLint flat config, pinned Playwright 1.64.0.
- URL/HTML/file → PDF through Chromium's native `page.pdf()`; typed errors
  with stable codes; `Deadline`; isolated browser manager.

### Phase 2 — Core rendering
- `screen` mode with the `paper-fit` output policy (paper-uniform scale,
  never upscales); `document` mode with print CSS, paper/margins/scale.
- Cancellation via `AbortSignal`; capture/paper modules; layout analysis and
  renderer diagnostics.

### Phase 3 — Readiness & quality
- Readiness phase (fonts, images, network idle, selector, settle) under a
  single deadline; observed resource diagnostics; text-extraction checks;
  structured quality report; `QUALITY_POLICY_FAILED` policies.

### Phase 4 — CLI & documentation
- `pageforge convert|inspect` with `--json`/`--quiet`, stable exit codes
  (0/2/3/4/130), SIGINT cancellation; getting-started, modes, API, CLI, and
  security docs.

### Phase 5 — Security & reliability
- Per-conversion request guard: subresource and page-scripted navigation
  classification (`BLOCKED_RESOURCE`, `BLOCKED_URL`), redirect `Location`
  classification (`BLOCKED_REDIRECT`), request caps
  (`RESOURCE_LIMIT_EXCEEDED`), output-byte and fail-fast concurrency limits,
  credential redaction on error paths.

### Phase 6 — Benchmark, CI, container
- `pageforge benchmark`: deterministic scenarios; PageForge vs raw-Playwright
  baseline vs html2pdf.js vs WeasyPrint (skip-with-hint when absent, never
  fabricated); JSON + human reports.
- GitHub Actions CI (lint, typecheck, unit on Node 22/24; build + Playwright
  e2e on Chromium) and a production Docker image with Chromium's sandbox on.

### Local web UI (`pageforge-web`, development tool)
- `pnpm web`: localhost-only server with a browser form — target URL in, PDF
  out, quality-report summary and typed security errors shown inline.
  Loopback/private targets need explicit `--allow-loopback` /
  `--allow-private-network` at startup; the UI cannot escalate policy.
- "Tolerant readiness" option (`tolerant: true` in the API): skips waiting on
  images/network idle for sites that keep requests open forever (streaming
  assets, long polling); fonts are still awaited. Default stays strict.
- `PAPER_FORMATS` and `PaperFormat` are now exported from `pageforge-pdf`.

### Browser presentation
- New `browser.userAgent` convert option. Default: a standard `Chrome` UA for
  the running Chromium build (the `HeadlessChrome` token removed), because
  production sites and WAFs frequently serve 403/500 pages to that string.
  This changes the UA string only — TLS/HTTP2 fingerprints still identify an
  automated browser; it is a compatibility shim, not an anonymity control.

### Phase 7 — Adaptive readiness
- Per-resource patience: new `readiness.slowResourceMs` (default 10s, `0`
  disables). A pending image that outlives its individual patience no longer
  spends the shared deadline — the conversion proceeds with a `resources.slow`
  warning naming the asset, and network quiet ignores requests older than the
  patience so a hung asset cannot re-block the idle check.
- Lazy-load drain: new `readiness.lazyLoad` (default `true`). Scrollable
  documents that declare lazy markers are swept with bounded scroll steps
  before the other checks so `loading="lazy"`/`data-src` content is actually
  fetched; scroll position is restored, and a sweep that hits its step limit
  reports `resources.lazy-load-truncated`.
- Navigation now waits for DOMContentLoaded; subresource settling belongs to
  the readiness phase (where patience applies). A hanging asset in the initial
  document is a warned slow resource instead of a navigation-stage timeout.
- Bug fix: a readiness poll abandoned by a firing deadline could reject
  unhandled ("Target closed") after its context closed, terminating the host
  Node process — found via the web UI dying mid-conversion. `withDeadline`
  now abandons in-flight work safely, with a regression test; the web UI also
  logs stray rejections instead of exiting.

### Phase 8a — Render-fidelity verification
- New post-render verification phase (on by default): sampled pages of the
  produced PDF are re-rasterized inside Chromium with pdf.js and compared,
  page by page, against screenshots of the live page captured under the same
  media emulation and at the print layout width. The comparison runs entirely
  in-browser (canvas pixel access) — no native dependencies, no pixel data
  leaves the process.
- `fidelity` convert options: `enabled` (default `true`), `samplePages`
  (1–50 or `"all"`, default `3`), `threshold` (default `0.8`). Results land in
  `report.fidelity` (per-page SSIM, pHash distance, alignment offset) with a
  `render.fidelity` check and `fidelity.low-score` / `fidelity.skipped`
  warnings.
- Honesty rules: scores are a heuristic visual comparison, never a
  pixel-perfectness claim; any infrastructure failure or unverifiable layout
  (header/footer templates, unmappable `pageRanges`, differing page sizes)
  degrades to `status: "skipped"` with the reason — scores are never
  fabricated. Cancellation still propagates as `CANCELLED`.

### Phase 8b — Failure forensics
- New `diagnostics` convert option (default `false`): console messages (ring
  buffer: last 100 entries, 2000 chars each), uncaught page exceptions, and
  network activity are recorded from the moment the page is created. On
  failure the captured state plus a best-effort JPEG screenshot and the
  serialized DOM (capped at 256 KiB) attach to the error as
  `error.details.diagnostics`.
- Forensics are best effort by design: a capture step that cannot run is
  listed in `incomplete[]` (never silently dropped), the whole artifact
  phase is bounded by a 5s deadline, and `CANCELLED` never waits on — or is
  masked by — forensics.
- CLI: `--diagnostics` writes the bundle next to the intended output as
  `<output>.diag/` (`meta.json`, `page.html`, `screenshot.jpg`). The local
  web UI always collects forensics so its error card can show what failed.
